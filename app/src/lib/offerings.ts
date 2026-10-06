/**
 * Offerings: the marketplace's view of the chain. Each engine process whose
 * definition carries a product term sheet is one issuance; everything shown
 * (terms, book, strike, observations, payouts) is read from its accounts.
 */
import { PublicKey } from '@solana/web3.js';
import {
  decToString, PRODUCT_LABELS, SCALE, simulatePayoff, slotValue, totalPerUnit,
  type Engine, type ProcessAccount, type ProductParams, type WorkflowDef,
} from '@stratosnotes/flow';

export const NOTE = 0;
export const CASH = 1;

export type Phase = 'book' | 'fixing' | 'live' | 'redeemed';

export interface Offering {
  address: PublicKey;
  definition: PublicKey;
  def: WorkflowDef;
  /** The term sheet when the workflow is (or started from) a stock product. */
  params: ProductParams;
  /** Edited in the studio: the payoff is defined by the workflow, not a reference engine. */
  custom: boolean;
  label: string;
  process: ProcessAccount;
  issuer: PublicKey;
  isin: string;
  notional: number;
  sold: number;
  strikeDate: number;
  obsDates: number[];
  strike: number | null;
  observed: number[];
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
  const custom = !!meta.custom || !meta.product;
  // A workflow with no term sheet still lists; its card and page describe the workflow instead.
  const params: ProductParams = meta.product ?? {
    productType: 'fcn', name: def.name || 'Custom workflow', issuePricePct: 100,
    underlying: { symbol: '—', feed: '', feedChain: '', minPrice: 0, maxPrice: 0 }, observations: def.fields.filter(f => /^obsDate\d+$/.test(f.name)).length,
  };
  const stepIndex = Object.fromEntries(def.steps.map((s, i) => [s.id, i]));
  const notional = num(field(p, def, 'notional'));
  const strikeDate = Number(field(p, def, 'strikeDate') ?? 0);
  const obsDates = Array.from({ length: params.observations }, (_, k) => Number(field(p, def, `obsDate${k + 1}`) ?? 0));
  const strikeRaw = field(p, def, 'initialLevel');
  const strike = strikeRaw === null ? null : num(strikeRaw);
  const observed: number[] = [];
  for (let k = 1; k <= params.observations; k++) {
    const v = field(p, def, `obs${k}`);
    if (v === null) break;
    observed.push(num(v));
  }
  const issuer = p.roles[0];
  const issuerNotes = num(p.holdings.find(h => h.owner.equals(issuer) && h.asset === NOTE)?.amount ?? 0n);
  const issued = notional > 0 && p.holdings.some(h => h.asset === NOTE);
  const sold = issued ? notional - issuerNotes : 0;
  const activeSteps = [...new Set(p.tokens.map(t => def.steps[t]?.id).filter(Boolean))] as string[];
  const windowOpen = def.steps.some((s, i) => s.until && p.tokens.includes(i));
  const phase: Phase = p.status === 1 ? 'redeemed'
    : windowOpen && (strikeDate ? now < strikeDate : true) ? 'book'
    : strike === null ? 'fixing' : 'live';

  let outcome: Offering['outcome'] = null;
  if (!custom && strike !== null && observed.length) {
    const path = [...observed, ...new Array(params.observations - observed.length).fill(observed[observed.length - 1])];
    const r = simulatePayoff(params, strike, path);
    const finished = p.status === 1;
    outcome = { calledAt: r.calledAt && r.calledAt <= observed.length ? r.calledAt : undefined, finished, perUnit: totalPerUnit(r) };
  }
  return {
    address: p.address, definition: p.definition, def, params, custom, label: meta.product ? (custom ? `Custom ${PRODUCT_LABELS[params.productType]}` : PRODUCT_LABELS[params.productType]) : 'Custom workflow', process: p,
    issuer, isin: String(field(p, def, 'isin') ?? ''), notional: Number.isFinite(notional) ? notional : 0, sold,
    strikeDate, obsDates, strike, observed, phase, activeSteps, stepIndex, outcome,
  };
}

/** Every offering on the engine, newest first. */
export async function loadOfferings(engine: Engine): Promise<Offering[]> {
  const procs = await engine.processes();
  const defs = new Map<string, WorkflowDef>();
  for (const k of new Set(procs.map(p => p.definition.toBase58()))) {
    try { defs.set(k, (await engine.definition(new PublicKey(k))).def); } catch { /* unsealed or foreign */ }
  }
  return procs
    .map(p => { const d = defs.get(p.definition.toBase58()); return d ? toOffering(p, d) : null; })
    .filter((o): o is Offering => !!o)
    .sort((a, b) => b.process.createdAt - a.process.createdAt);
}

/** A wallet's position in one offering: note units held and cash it can withdraw. */
export function position(o: Offering, owner: PublicKey) {
  const h = (asset: number) => o.process.holdings.find(x => x.owner.equals(owner) && x.asset === asset)?.amount ?? 0n;
  return { units: num(h(NOTE)), cash: num(h(CASH)), cashRaw: h(CASH) };
}

export const fmtMoney = (x: number, dp = 2) => x.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtPrice = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
export const fmtDate = (t: number) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export { decToString };
