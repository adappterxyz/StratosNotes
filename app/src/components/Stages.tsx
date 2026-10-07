/**
 * The workspace's stages, in order (Flow's right panel): Overview, Validate,
 * Payoff, Template, Issue. Each works on the workflow open on the canvas.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  dec, FKIND, PRODUCT_LABELS, pda, reservePerUnit, simulatePerf, slot, templateMessage, totalPerUnit, underlyingLabel,
  type Compiled, type Issue, type ProductParams, type Slot, type TemplateSource, type TemplateSummary, type WorkflowIR,
} from '@stratosnotes/flow';
import PayoffChart from './PayoffChart';
import { DEPLOYMENT, explorer } from '../config';
import { useEngine } from '../lib/engine';
import { FIELD_LABEL, obsIndex, planIssuance, rolesFor } from '../lib/issuance';
import { fmtMoney, headline, short } from '../lib/offerings';

export interface DocInfo {
  name: string;
  /** product: opened from a term sheet; custom: a BPMN workflow (edited, imported, from AI or blank). */
  origin: 'product' | 'custom';
  basis: ProductParams | null;
  edited: boolean;
  template?: TemplateSummary;
  /** From the AI's reading of a term sheet: the issuance size and schedule it stated. */
  hint?: { size?: number; every?: number; unit?: 'months' | 'days' | 'minutes' };
}

/** What a stage needs from the open workflow, compiled as it would be published. */
export interface Built { ir: WorkflowIR; c: Compiled; source: TemplateSource }

const Head = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="section"><h2>{title}</h2>{sub && <p className="xs muted">{sub}</p>}</div>
);

// ---- Overview ---------------------------------------------------------------

export function OverviewPanel({ doc, info, onEditTerms, onStage }: {
  doc: DocInfo; info: { pools: string[]; steps: number; fields: string[]; errors: number; warnings: number };
  onEditTerms: () => void; onStage: (s: Stage) => void;
}) {
  const p = doc.basis;
  return (
    <>
      <Head title={doc.name} sub={doc.template ? `Template by ${short(doc.template.author)}` : undefined} />
      <div className="section">
        <div className="row">
          <span className={`pill ${doc.origin === 'product' && !doc.edited ? 'book' : 'live'}`}><span className="dot" />{doc.origin === 'product' && !doc.edited ? 'Stock product' : doc.edited && doc.origin === 'product' ? 'Edited: custom workflow' : 'Custom workflow'}</span>
          <span className="xs muted">{info.steps} steps · {info.pools.length} pools</span>
        </div>
        <p className="xs muted">{doc.origin === 'product' && !doc.edited
          ? 'Runs a verified payoff engine: the marketplace prices it from the reference payoff.'
          : 'The workflow on the canvas is the payoff: it runs exactly as drawn.'}</p>
      </div>
      {p && (
        <div className="section">
          <span className="label">Term sheet{doc.edited ? ' (started from)' : ''}</span>
          <div className="small"><strong>{PRODUCT_LABELS[p.productType]}</strong> on {underlyingLabel(p)}</div>
          <div className="xs muted">{headline(p)} · {p.observations} observation{p.observations > 1 ? 's' : ''} · issue price {p.issuePricePct}%</div>
          <div><button className="btn" onClick={onEditTerms}>Edit terms</button></div>
        </div>
      )}
      <div className="section">
        <span className="label">Pools</span>
        <div className="row">{info.pools.map(x => <span key={x} className="pill plain">{x}</span>)}</div>
        <span className="label" style={{ marginTop: 4 }}>Fields</span>
        <div className="xs muted num" style={{ lineHeight: 1.7 }}>{info.fields.join(', ') || 'none'}</div>
      </div>
      <div className="section">
        <span className="label">Next</span>
        <div className="row">
          <button className="btn" onClick={() => onStage('validate')}>{info.errors ? `Fix ${info.errors} error${info.errors > 1 ? 's' : ''}` : 'Validate'}</button>
          <button className="btn" onClick={() => onStage('template')}>Save as template</button>
          <button className="btn primary" onClick={() => onStage('issue')} disabled={info.errors > 0}>Issue</button>
        </div>
        <p className="xs muted">Select a step, gateway or flow on the canvas to edit what it does.</p>
      </div>
    </>
  );
}

// ---- Validate ---------------------------------------------------------------

export function ValidatePanel({ issues, onSelect }: { issues: { errors: Issue[]; warnings: Issue[] }; onSelect: (id: string) => void }) {
  const ok = !issues.errors.length && !issues.warnings.length;
  return (
    <>
      <Head title="Validate" sub="The validator and the engine's compiler check every change as you make it." />
      <div className="section">
        {ok && <div className="notice ok row"><CheckCircle2 className="i" />The engine accepts this workflow.</div>}
        <ul className="issues">
          {issues.errors.map((e, i) => <li key={`e${i}`} className={`err ${e.nodeId ? 'click' : ''}`} onClick={() => e.nodeId && onSelect(e.nodeId)}><AlertCircle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />{e.message}</li>)}
          {issues.warnings.map((w, i) => <li key={`w${i}`} className={`warn ${w.nodeId ? 'click' : ''}`} onClick={() => w.nodeId && onSelect(w.nodeId)}><AlertTriangle className="i" style={{ verticalAlign: -2, marginRight: 6 }} />{w.message}</li>)}
        </ul>
      </div>
    </>
  );
}

// ---- Payoff (what-if) -------------------------------------------------------

export function PayoffPanel({ doc }: { doc: DocInfo }) {
  const p = doc.basis;
  const [path, setPath] = useState<number[]>(() => new Array(p?.observations ?? 0).fill(100));
  if (!p || doc.edited || doc.origin !== 'product') {
    return (
      <>
        <Head title="Payoff" />
        <div className="section"><p className="small muted">{p ? 'This workflow was edited, so its payoff is the workflow itself: there is no reference payoff to chart. Issue it and watch it run, or reopen the term sheet for a stock product.' : 'Custom workflows have no reference payoff: the workflow is the payoff.'}</p></div>
      </>
    );
  }
  const n = p.observations;
  const perfs = Array.from({ length: n }, (_, k) => (path[k] ?? 100) / 100);
  const r = simulatePerf(p, perfs);
  const basket = p.underlyings.length > 1;
  return (
    <>
      <Head title="Payoff" sub="The reference payoff the on-chain workflow is tested against." />
      <div className="section">
        <span className="label">Payout per 100 at maturity</span>
        <PayoffChart params={p} />
      </div>
      <div className="section">
        <span className="label">What if: {basket ? 'worst performance' : 'level'} at each observation, % of strike</span>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(70px, 1fr))' }}>
          {Array.from({ length: n }, (_, k) => (
            <div key={k} className="field">
              <label htmlFor={`wi-${k}`}>Obs {k + 1}</label>
              <input id={`wi-${k}`} type="number" value={path[k] ?? 100} onChange={e => setPath(x => { const y = [...x]; y[k] = Number(e.target.value); return y; })} />
            </div>
          ))}
        </div>
        <table className="t">
          <tbody>
            {r.coupons.map((c, k) => <tr key={k}><td>Observation {k + 1}{r.calledAt === k + 1 ? ' · autocalled' : ''}</td><td className="r num">{(c * 100).toFixed(2)}</td></tr>)}
            <tr><td>Redemption</td><td className="r num">{(r.redemptionCash * 100).toFixed(2)}</td></tr>
            <tr><td><strong>Total per 100</strong></td><td className="r num"><strong>{(totalPerUnit(r) * 100).toFixed(2)}</strong></td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Template -----------------------------------------------------------------

export function TemplatePanel({ doc, build, onSaved }: { doc: DocInfo; build: () => Promise<Built>; onSaved: (t: TemplateSummary) => void }) {
  const { engine, connected } = useEngine();
  const { publicKey, signMessage } = useWallet();
  const [name, setName] = useState(doc.template && !doc.edited ? doc.template.name : doc.name);
  const [description, setDescription] = useState(doc.template && !doc.edited ? doc.template.description : '');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const save = async () => {
    if (!publicKey || !signMessage) return;
    setMsg(null);
    try {
      setBusy('Compiling…');
      const { c, source } = await build();
      setBusy('Publishing the workflow on Solana…');
      const definition = (await engine.publish(c)).toBase58();
      setBusy('Sign the template with your wallet…');
      const sig = await signMessage(new TextEncoder().encode(templateMessage(definition)));
      setBusy('Saving to the template library…');
      const r = await fetch('/api/templates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry: { ...source, definition, name, description, author: publicKey.toBase58() }, signature: btoa(String.fromCharCode(...sig)) }),
      });
      const j = await r.json() as TemplateSummary & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `Template library error ${r.status}`);
      setMsg({ kind: 'ok', text: `Saved "${j.name}". Issuers can now pick it from Issue → Templates.` });
      onSaved(j);
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(''); }
  };
  return (
    <>
      <Head title="Save as template" sub="Publish this workflow so that you, or any issuer, can issue it again from the template library." />
      <div className="section">
        {doc.template && !doc.edited && <div className="notice info">Opened from the template "{doc.template.name}" by {short(doc.template.author)}. Saving again under a new name lists it separately.</div>}
        <div className="field"><label htmlFor="tp-name">Name</label><input id="tp-name" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="tp-desc">Description</label><textarea id="tp-desc" rows={3} maxLength={280} value={description} onChange={e => setDescription(e.target.value)} placeholder="Who it is for, what is special about it" /></div>
        <p className="xs muted">The workflow is stored on Solana once (its address is the hash of its contents); the library keeps its name, your wallet as author and the diagram so it opens here.</p>
        <button className="btn primary lg" disabled={!connected || !!busy || !name.trim() || !signMessage} onClick={save}>
          {!connected ? 'Connect a wallet' : !signMessage ? 'This wallet cannot sign messages' : busy || 'Publish template'}
        </button>
        {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text}</div>}
      </div>
    </>
  );
}

// ---- Issue ------------------------------------------------------------------

const toLocalInput = (t: number) => { const d = new Date(t * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(FKIND).map(([k, v]) => [v, k]));

export function IssuePanel({ doc, built }: { doc: DocInfo; built: Built | null }) {
  const nav = useNavigate();
  const { engine, connected } = useEngine();
  const { publicKey } = useWallet();
  const plan = useMemo(() => { try { return built ? planIssuance(built.ir, built.c) : null; } catch (e) { return e instanceof Error ? e.message : String(e); } }, [built]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [size, setSize] = useState(doc.hint?.size ?? 10_000);
  const [strikeIn, setStrikeIn] = useState(5);
  const [every, setEvery] = useState({ n: 3, unit: 'minutes' as 'minutes' | 'days' | 'months' });
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [isin] = useState(() => 'XS' + String(Date.now()).slice(-10));

  if (!built) return <><Head title="Issue" /><div className="section"><p className="small muted">Fix the errors in Validate first.</p></div></>;
  if (typeof plan === 'string' || !plan) return <><Head title="Issue" /><div className="section"><div className="notice err">{plan}</div></div></>;

  const all = [plan.start, ...plan.steps];
  const inputs = all.flatMap(s => s.inputs);
  const hasSchedule = plan.dateFields.includes('strikeDate');
  const strikeAt = Math.floor(Date.now() / 60000) * 60 + strikeIn * 60;
  const dateOf = (name: string) => {
    const k = obsIndex(name);
    if (k === 0) return strikeAt;
    if (every.unit === 'months') { const d = new Date(strikeAt * 1000); d.setUTCMonth(d.getUTCMonth() + every.n * k); return Math.floor(d.getTime() / 1000); }
    return strikeAt + k * every.n * (every.unit === 'days' ? 86400 : 60);
  };
  const p = doc.basis;
  const perUnitReserve = p ? (reservePerUnit(p) ?? (p.participationPct ?? 0) / 100) : 0;
  const reserve = Math.ceil(size * perUnitReserve * 100) / 100;
  const auto = (name: string): string | null => {
    if (name === 'notional') return String(size);
    if (name === 'isin') return values.isin ?? isin;
    if (hasSchedule && plan.dateFields.includes(name)) return String(dateOf(name));
    if (name === 'reserve' && p && values.reserve === undefined) return reserve.toFixed(2);
    return null;
  };
  const kindOf = (name: string) => inputs.find(f => f.name === name)?.kind;
  const valueOf = (name: string) => auto(name) ?? values[name] ?? (kindOf(name) === FKIND.Date ? toLocalInput(strikeAt) : '');
  const generic = inputs.filter(f => !(['notional', 'isin'].includes(f.name) || (hasSchedule && plan.dateFields.includes(f.name))));

  const issue = async () => {
    if (!publicKey) return;
    setBusy(true); setError(''); setProgress([]);
    const step = (s: string) => setProgress(x => [...x, s]);
    try {
      if (hasSchedule && strikeAt < Date.now() / 1000 + 60) throw new Error('The strike date must be at least a minute away.');
      const slots = (names: Array<{ name: string; kind: number }>): Slot[] => names.map(f => {
        const raw = valueOf(f.name).trim();
        if (!raw) throw new Error(`Enter ${FIELD_LABEL[f.name] ?? f.name}.`);
        if (f.kind === FKIND.Text) return slot.text(raw);
        if (f.kind === FKIND.Party) return slot.key(new PublicKey(raw));
        if (f.kind === FKIND.Date) return slot.number(BigInt(/^\d+$/.test(raw) ? raw : Math.floor(new Date(raw).getTime() / 1000)));
        if (f.kind === FKIND.Bool) return slot.number(raw === 'true' ? 1n : 0n);
        if (f.kind === FKIND.Int) return slot.number(BigInt(raw));
        return slot.number(dec(raw));
      });
      const startInputs = slots(plan.start.inputs);
      const stepInputs = plan.steps.map(s => slots(s.inputs));
      const { ir, c } = built;
      step(`Workflow compiled: ${c.def.steps.length} steps, ${c.bytes.length.toLocaleString()} bytes.`);
      const definition = await engine.publish(c);
      step('Definition on Solana (shared by every issuance of this workflow).');
      const usdc = new PublicKey(DEPLOYMENT.testUsdc);
      const mints = ir.assets.map(a => (a.kind === 'cash' ? usdc : PublicKey.default));
      const id = BigInt(Date.now());
      const process = pda.process(definition, publicKey, id);
      await engine.send([
        await engine.startProcess(definition, id, rolesFor(ir, publicKey), mints, plan.start.index, startInputs),
        ...await Promise.all(plan.cashAssets.map(a => engine.openVault(process, a, mints[a]))),
      ]);
      step('Issuance started.');
      if (plan.steps.length) {
        await engine.send(await Promise.all(plan.steps.map((s, i) =>
          engine.executeStep(process, definition, s.index, stepInputs[i], s.deposit !== null ? { deposit: { asset: s.deposit, mint: mints[s.deposit] } } : {}))));
        step(`${plan.steps.map(s => s.name).join(', ')}: done.`);
      }
      nav(`/note/${process.toBase58()}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const deposits = plan.steps.filter(s => s.deposit !== null);
  return (
    <>
      <Head title="Issue" sub="Pre-trade terms for this issuance. Publishing opens the book: investors subscribe until the strike date, then Chainlink CRE takes over." />
      <div className="section">
        <span className="label">Roles</span>
        <p className="xs muted">Your wallet holds {plan.heldPools.join(', ')}{plan.openPools.length ? `; ${plan.openPools.join(', ')} is open to anyone` : ''}. Runs: {all.map(s => s.name).join(' → ')}.</p>
      </div>
      <div className="section">
        <div className="form-grid">
          {inputs.some(f => f.name === 'notional') && (
            <div className="field"><label htmlFor="is-size">{FIELD_LABEL.notional}</label><input id="is-size" type="number" min={1} value={size} onChange={e => setSize(Number(e.target.value))} /></div>
          )}
          {inputs.some(f => f.name === 'isin') && (
            <div className="field"><label htmlFor="is-isin">{FIELD_LABEL.isin}</label><input id="is-isin" maxLength={32} value={values.isin ?? isin} onChange={e => setValues(v => ({ ...v, isin: e.target.value }))} /></div>
          )}
        </div>
      </div>
      {hasSchedule && (
        <div className="section">
          <span className="label">Schedule</span>
          <div className="form-grid">
            <div className="field"><label htmlFor="is-strike">Strike in (minutes)</label><input id="is-strike" type="number" min={2} value={strikeIn} onChange={e => setStrikeIn(Math.max(2, Number(e.target.value) || 2))} /></div>
            <div className="field">
              <label htmlFor="is-every">Observe every</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="is-every" type="number" min={1} value={every.n} onChange={e => setEvery({ ...every, n: Number(e.target.value) || 1 })} style={{ width: 70 }} />
                <select aria-label="Interval unit" value={every.unit} onChange={e => setEvery({ ...every, unit: e.target.value as typeof every.unit })}>
                  <option value="minutes">minutes</option><option value="days">days</option><option value="months">months</option>
                </select>
              </div>
            </div>
          </div>
          <p className="xs muted">Strike {new Date(strikeAt * 1000).toLocaleString()}; then {plan.dateFields.filter(f => f !== 'strikeDate').map(f => (every.unit === 'minutes' ? new Date(dateOf(f) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date(dateOf(f) * 1000).toLocaleDateString([], { dateStyle: 'medium' }))).join(' · ')}. Minutes apart runs a whole lifecycle on-chain while you watch.</p>
        </div>
      )}
      {generic.length > 0 && (
        <div className="section">
          <span className="label">Terms</span>
          <div className="form-grid">
            {generic.map(f => (
              <div key={f.name} className="field">
                <label htmlFor={`is-${f.name}`}>{FIELD_LABEL[f.name] ?? f.name} <span className="dim">({KIND_NAME[f.kind]})</span></label>
                <input id={`is-${f.name}`} type={f.kind === FKIND.Date ? 'datetime-local' : 'text'} value={valueOf(f.name)}
                  onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} />
                {f.name === 'reserve' && p && <span className="hint">Worst case above par: {fmtMoney(reserve)} USDC{p.productType === 'ppn' ? ' (sized for a 100% rise)' : ''}.</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="section">
        {deposits.length > 0 && <p className="xs muted">{deposits.map(s => s.name).join(', ')} deposits USDC from your wallet (devnet test USDC {short(DEPLOYMENT.testUsdc)}): use Test USDC in the top bar if you have none.</p>}
        <button className="btn primary lg" disabled={!connected || busy} onClick={issue}>
          {connected ? (busy ? 'Issuing…' : 'Publish and open the book') : 'Connect a wallet to issue'}
        </button>
        {progress.length > 0 && <ol className="xs muted" style={{ margin: 0, paddingLeft: 18 }}>{progress.map(s => <li key={s}>{s}</li>)}</ol>}
        {error && <div className="notice err" role="alert">{error}</div>}
        <a className="xs" href={explorer('address', DEPLOYMENT.engine)} target="_blank" rel="noreferrer">Engine program on Solana Explorer</a>
      </div>
    </>
  );
}

export type Stage = 'design' | 'validate' | 'payoff' | 'template' | 'issue';
