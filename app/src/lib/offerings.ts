/**
 * Offerings: the marketplace's view of the chain. Each engine process whose
 * definition carries a product term sheet is one issuance; everything shown
 * (terms, book, strikes, observations, payouts) is read from its accounts.
 */
import { PublicKey } from '@solana/web3.js';
import {
  decToString, normalizeParams, PRODUCT_LABELS, SCALE, simulatePerf, slotValue, totalPerUnit, underlyingLabel,
  type Engine, type ProcessAccount, type ProductParams, type WorkflowDef,
} from '@stratosnotes/flow';

export const NOTE = 0;
export const CASH = 1;

export type Phase = 'book' | 'fixing' | 'live' | 'redeemed';
export const PHASES: Phase[] = ['book', 'fixing', 'live', 'redeemed'];
export const PHASE_LABEL: Record<Phase, string> = { book: 'Book open', fixing: 'Fixing strike', live: 'Live', redeemed: 'Redeemed' };

export interface UnderlyingState {
  symbol: string;
  feed: string;
  feedChain: string;
  strike: number | null;
  /** Level at each observation so far. */
  observed: number[];
}

export interface Offering {
  address: PublicKey;
  definition: PublicKey;
  def: WorkflowDef;
  /** The term sheet when the workflow is (or started from) a stock product. */
  params: ProductParams;
  hasTerms: boolean;
  /** Edited in the studio: the payoff is defined by the workflow, not a reference engine. */
  custom: boolean;
  label: string;
  underlyingText: string;
  process: ProcessAccount;
  issuer: PublicKey;
  isin: string;
  notional: number;
  sold: number;
  strikeDate: number;
  obsDates: number[];
  unds: UnderlyingState[];
  strikeFixed: boolean;
  /** Worst performance (level / strike) at each completed observation. */
  perfs: number[];
  phase: Phase;
  activeSteps: string[];
  stepIndex: Record<string, number>;
  /** Payoff so far along the observed path (null before the strike). */
  outcome: { calledAt?: number; finished: boolean; perUnit: number } | null;
}

const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) / Number(SCALE) : NaN);

function field(p: ProcessAccount, def: WorkflowDef, name: string) {
  const i = def.fields.findIndex(f => f.name === name);
  return i < 0 ? null : slotValue(p.values[i], def.fields[i].kind);
}

export function toOffering(p: ProcessAccount, def: WorkflowDef, now = Date.now() / 1000): Offering | null {
  let meta: { product?: ProductParams; custom?: boolean } = {};
  try { meta = JSON.parse(def.meta); } catch { return null; }
  const hasTerms = !!meta.product;
  const custom = !!meta.custom || !hasTerms;
  // A workflow with no term sheet still lists; its page describes the workflow instead.
  const params: ProductParams = meta.product ? normalizeParams(meta.product) : {
    productType: 'fcn', name: def.name || 'Custom workflow', issuePricePct: 100,
    underlyings: [], observations: def.fields.filter(f => /^obsDate\d+$/.test(f.name)).length,
  };
  const stepIndex = Object.fromEntries(def.steps.map((s, i) => [s.id, i]));
  const notional = num(field(p, def, 'notional'));
  const strikeDate = Number(field(p, def, 'strikeDate') ?? 0);
  const obsDates = Array.from({ length: params.observations }, (_, k) => Number(field(p, def, `obsDate${k + 1}`) ?? 0));

  // One underlying: initialLevel / obsK. A worst-of basket: initialLevel_SYM / obsK_SYM.
  const basket = params.underlyings.length > 1;
  const unds: UnderlyingState[] = params.underlyings.map(u => {
    const s = field(p, def, basket ? `initialLevel_${u.symbol}` : 'initialLevel');
    const observed: number[] = [];
    for (let k = 1; k <= params.observations; k++) {
      const v = field(p, def, basket ? `obs${k}_${u.symbol}` : `obs${k}`);
      if (v === null) break;
      observed.push(num(v));
    }
    return { symbol: u.symbol, feed: u.feed, feedChain: u.feedChain, strike: s === null ? null : num(s), observed };
  });
  const strikeFixed = unds.length > 0 && unds.every(u => u.strike !== null);
  const nObs = unds.length ? Math.min(...unds.map(u => u.observed.length)) : 0;
  const perfs = strikeFixed ? Array.from({ length: nObs }, (_, k) => Math.min(...unds.map(u => u.observed[k] / u.strike!))) : [];

  const issuer = p.roles[0];
  const issuerNotes = num(p.holdings.find(h => h.owner.equals(issuer) && h.asset === NOTE)?.amount ?? 0n);
  const issued = notional > 0 && p.holdings.some(h => h.asset === NOTE);
  const sold = issued ? notional - issuerNotes : 0;
  const activeSteps = [...new Set(p.tokens.map(t => def.steps[t]?.id).filter(Boolean))] as string[];
  const windowOpen = def.steps.some((s, i) => s.until && p.tokens.includes(i));
  const phase: Phase = p.status === 1 ? 'redeemed'
    : windowOpen && (strikeDate ? now < strikeDate : true) ? 'book'
    : unds.length && !strikeFixed ? 'fixing' : 'live';

  let outcome: Offering['outcome'] = null;
  if (!custom && strikeFixed && perfs.length) {
    const path = [...perfs, ...new Array(params.observations - perfs.length).fill(perfs[perfs.length - 1])];
    const r = simulatePerf(params, path);
    outcome = { calledAt: r.calledAt && r.calledAt <= perfs.length ? r.calledAt : undefined, finished: p.status === 1, perUnit: totalPerUnit(r) };
  }
  const label = hasTerms ? (custom ? `Custom ${PRODUCT_LABELS[params.productType]}` : PRODUCT_LABELS[params.productType]) : 'Custom workflow';
  return {
    address: p.address, definition: p.definition, def, params, hasTerms, custom, label, underlyingText: hasTerms ? underlyingLabel(params) : '—', process: p,
    issuer, isin: String(field(p, def, 'isin') ?? ''), notional: Number.isFinite(notional) ? notional : 0, sold,
    strikeDate, obsDates, unds, strikeFixed, perfs, phase, activeSteps, stepIndex, outcome,
  };
}

// Sealed definitions never change: read each once per session.
const defCache = new Map<string, Promise<WorkflowDef | null>>();
function definitionOf(engine: Engine, key: string) {
  if (!defCache.has(key)) defCache.set(key, engine.definition(new PublicKey(key)).then(d => (d.sealed ? d.def : null)).catch(() => { defCache.delete(key); return null; }));
  return defCache.get(key)!;
}

/** Every offering on the engine, newest first. */
export async function loadOfferings(engine: Engine): Promise<Offering[]> {
  const procs = await engine.processes();
  const keys = [...new Set(procs.map(p => p.definition.toBase58()))];
  const defs = new Map(await Promise.all(keys.map(async k => [k, await definitionOf(engine, k)] as const)));
  return procs
    .map(p => { const d = defs.get(p.definition.toBase58()); return d ? toOffering(p, d) : null; })
    .filter((o): o is Offering => !!o)
    .sort((a, b) => b.process.createdAt - a.process.createdAt);
}

/** One offering, read directly (the note page). */
export async function loadOffering(engine: Engine, address: PublicKey): Promise<Offering | null> {
  const p = await engine.process(address);
  const d = await definitionOf(engine, p.definition.toBase58());
  return d ? toOffering(p, d) : null;
}

/** A wallet's position in one offering: note units held and cash it can withdraw. */
export function position(o: Offering, owner: PublicKey) {
  const h = (asset: number) => o.process.holdings.find(x => x.owner.equals(owner) && x.asset === asset)?.amount ?? 0n;
  return { units: num(h(NOTE)), cash: num(h(CASH)), cashRaw: h(CASH) };
}

/** One line describing the payoff, from the term sheet. */
export function headline(o: ProductParams) {
  const parts: string[] = [];
  if (o.couponRatePct) parts.push(`${o.couponRatePct}% ${o.productType === 'snowball' ? 'accrued' : 'coupon'} / period`);
  if (o.couponBarrierPct) parts.push(`coupon barrier ${o.couponBarrierPct}%${o.memory ? ' (memory)' : ''}`);
  if (o.autocallLevelPct) parts.push(`autocall ${o.autocallLevelPct}%`);
  if (o.knockInBarrierPct) parts.push(`knock-in ${o.knockInBarrierPct}%`);
  if (o.protectionPct) parts.push(`${o.protectionPct}% protected, ${o.participationPct}% participation`);
  if (o.settlement === 'physical') parts.push('physical delivery');
  return parts.join(' · ');
}

/** What happens next, in a few words. */
export function nextEvent(o: Offering) {
  if (o.phase === 'book') return `Book closes ${fmtDate(o.strikeDate)}`;
  if (o.phase === 'fixing') return 'Waiting for the CRE strike fixing';
  if (o.phase === 'live') {
    const k = o.perfs.length;
    return o.obsDates[k] ? `Observation ${k + 1} ${fmtDate(o.obsDates[k])}` : 'In progress';
  }
  return o.outcome?.calledAt ? `Autocalled at observation ${o.outcome.calledAt}` : 'Matured';
}

export const fmtMoney = (x: number, dp = 2) => x.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtPrice = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtPct = (r: number) => `${(r * 100).toFixed(1)}%`;
export const fmtDate = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const short = (k: PublicKey | string) => { const s = typeof k === 'string' ? k : k.toBase58(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
export { decToString };
