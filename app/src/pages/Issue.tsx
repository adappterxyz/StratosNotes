import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  compile, dec, EXAMPLE_PRODUCTS, FEEDS, instantiateProduct, OPEN_ROLE, parseBpmn, pda, PRODUCT_LABELS, productUses,
  reservePerUnit, simulatePayoff, slot, totalPerUnit, validateProductParams, type ProductParams, type ProductType,
} from '@stratosnotes/flow';
import PayoffChart from '../components/PayoffChart';
import { DEPLOYMENT } from '../config';
import { useEngine } from '../lib/engine';
import { fmtMoney } from '../lib/offerings';

type Num = (v: number) => void;
function NumField({ id, label, value, onChange, hint, step = 'any' }: { id: string; label: string; value: number | undefined; onChange: Num; hint?: string; step?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" step={step} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

const toLocalInput = (t: number) => { const d = new Date(t * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export default function Issue() {
  const nav = useNavigate();
  const { engine, connected } = useEngine();
  const { publicKey } = useWallet();
  // Terms handed over by the AI or the studio, if any.
  const handed = (() => { try { return JSON.parse(sessionStorage.getItem('sn-ai-product') ?? 'null') as { params: ProductParams; schedule?: { every: number; unit: 'months' | 'days' | 'minutes'; count: number; size?: number } } | null; } catch { return null; } })();
  const [p, setP] = useState<ProductParams>(handed?.params ?? EXAMPLE_PRODUCTS.fcn);
  const [size, setSize] = useState(handed?.schedule?.size ?? 10_000);
  const [strikeAt, setStrikeAt] = useState(() => Math.floor(Date.now() / 1000) + 5 * 60);
  // Minutes by default so a whole lifecycle can be shown live; the AI's schedule (months) is offered too.
  const [every, setEvery] = useState({ n: 3, unit: 'minutes' as 'minutes' | 'days' | 'months' });
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiReply, setAiReply] = useState<{ text: string; notes?: string[]; bad?: boolean } | null>(null);
  const askAi = async () => {
    setBusy(true); setAiReply(null);
    try {
      const r = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: aiPrompt }) });
      const j = await r.json() as { kind?: string; params?: ProductParams; schedule?: { every: number; count: number; size?: number }; notes?: string[]; reply?: string; error?: string };
      if (j.kind === 'product' && j.params) {
        setP(j.params);
        if (j.schedule?.size) setSize(j.schedule.size);
        setAiReply({ text: `Filled in: ${j.params.name}. The term sheet observes every ${j.schedule?.every} months; for a live demo keep minutes below.`, notes: j.notes });
      } else setAiReply({ text: j.reply ?? j.error ?? 'No answer.', bad: j.kind === 'error' });
    } catch (e) { setAiReply({ text: e instanceof Error ? e.message : String(e), bad: true }); }
    finally { setBusy(false); }
  };
  const [isin, setIsin] = useState('XS' + String(Date.now()).slice(-10));
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<ProductParams>) => setP(prev => ({ ...prev, ...patch }));
  const pick = (t: ProductType) => setP({ ...EXAMPLE_PRODUCTS[t], underlying: p.underlying, issuePricePct: p.issuePricePct });
  const use = productUses(p.productType);
  const errors = validateProductParams(p);
  const obsTimes = useMemo(() => Array.from({ length: p.observations }, (_, k) => {
    if (every.unit === 'months') { const d = new Date(strikeAt * 1000); d.setUTCMonth(d.getUTCMonth() + every.n * (k + 1)); return Math.floor(d.getTime() / 1000); }
    return strikeAt + (k + 1) * every.n * (every.unit === 'days' ? 86400 : 60);
  }), [p.observations, strikeAt, every]);
  const perUnitReserve = reservePerUnit(p) ?? (p.participationPct ?? 0) / 100;
  const reserve = Math.ceil(size * perUnitReserve * 100) / 100;
  const flat = errors.length ? null : simulatePayoff(p, 100, new Array(p.observations).fill(100));

  const issue = async () => {
    if (!publicKey) return;
    setBusy(true); setError(''); setProgress([]);
    const step = (s: string) => setProgress(x => [...x, s]);
    try {
      const prod = instantiateProduct(p);
      const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
      step(`Workflow compiled (${c.def.steps.length} steps, ${c.bytes.length} bytes).`);
      const definition = await engine.publish(c);
      step('Workflow definition on-chain (shared by every issuance of these terms).');
      const usdc = new PublicKey(DEPLOYMENT.testUsdc);
      const id = BigInt(Date.now());
      const process = pda.process(definition, publicKey, id);
      // Self-service: you are the issuer and the paying agent; investors are an open role.
      await engine.send([
        await engine.startProcess(definition, id, [publicKey, publicKey, OPEN_ROLE], [PublicKey.default, usdc], c.stepIndex.Start_Issuer),
        await engine.openVault(process, 1, usdc),
      ]);
      step('Issuance started.');
      await engine.send([
        await engine.executeStep(process, definition, c.stepIndex.Task_ApproveTerms, [
          slot.text(isin.slice(0, 32)), slot.number(dec(size)), slot.number(BigInt(strikeAt)),
          ...obsTimes.map(t => slot.number(BigInt(t))), slot.number(dec(reserve.toFixed(2))),
        ], { deposit: { asset: 1, mint: usdc } }),
        await engine.executeStep(process, definition, c.stepIndex.Task_Mandate, []),
      ]);
      step(`Terms approved, ${fmtMoney(reserve)} USDC reserve deposited, book open.`);
      nav(`/note/${process.toBase58()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="stack" style={{ paddingTop: 28 }}>
      <div className="stack" style={{ gap: 8 }}>
        <span className="label">Self-service issuance</span>
        <h1>Issue a structured note</h1>
        <p className="muted" style={{ margin: 0, maxWidth: '64ch' }}>Pick a payoff, set this issuance's size and dates, and deposit the coupon reserve. The note opens for subscription at once; Chainlink CRE fixes the strike on the strike date and observes on every date after. Dates can be minutes apart, so a whole lifecycle runs on-chain while you watch.</p>
      </div>
      <section className="card stack" style={{ gap: 10 }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input aria-label="Describe the note" value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && aiPrompt.trim()) askAi(); }} style={{ flex: 1, font: '500 14px var(--font)', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--paper)', color: 'var(--ink)' }}
            placeholder='Paste or describe a term sheet: "12M snowball on BTC, 9% p.a. quarterly, autocall 100%, KI 65%, 25k USDC"' />
          <button className="btn" disabled={busy || !aiPrompt.trim()} onClick={askAi}>Fill with AI</button>
        </div>
        {aiReply && <div className={`notice ${aiReply.bad ? 'err' : 'info'}`}>{aiReply.text}{aiReply.notes?.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{aiReply.notes.map(n => <li key={n}>{n}</li>)}</ul> : null}</div>}
      </section>
      <div className="two">
        <div className="stack">
          <section className="card">
            <h3>Product</h3>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="type">Payoff</label>
                <select id="type" value={p.productType} onChange={e => pick(e.target.value as ProductType)}>
                  {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(t => <option key={t} value={t}>{PRODUCT_LABELS[t]}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="und">Underlying</label>
                <select id="und" value={p.underlying.symbol} onChange={e => set({ underlying: FEEDS[e.target.value as keyof typeof FEEDS] })}>
                  {Object.keys(FEEDS).map(k => <option key={k} value={k}>{k}/USD (Chainlink)</option>)}
                </select>
              </div>
              <div className="field" style={{ gridColumn: 'span 2' }}>
                <label htmlFor="name">Name</label>
                <input id="name" value={p.name} onChange={e => set({ name: e.target.value })} />
              </div>
              <NumField id="obs" label="Observations" value={p.observations} step="1" onChange={v => set({ observations: v, ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}) })} hint="The last is maturity" />
              <NumField id="price" label="Issue price %" value={p.issuePricePct} onChange={v => set({ issuePricePct: v })} />
              {use.coupon && <NumField id="cpn" label={p.productType === 'snowball' ? 'Accrued coupon / period %' : 'Coupon / period %'} value={p.couponRatePct} onChange={v => set({ couponRatePct: v })} />}
              {use.couponBarrier && <NumField id="cb" label="Coupon barrier %" value={p.couponBarrierPct} onChange={v => set({ couponBarrierPct: v })} />}
              {use.couponBarrier && (
                <div className="field"><label htmlFor="mem">Memory coupon</label>
                  <select id="mem" value={p.memory ? 'yes' : 'no'} onChange={e => set({ memory: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select>
                </div>
              )}
              {use.autocall && <NumField id="ac" label="Autocall level %" value={p.autocallLevelPct} onChange={v => set({ autocallLevelPct: v })} />}
              {use.autocall && <NumField id="acf" label="Autocall from observation" value={p.autocallFromPeriod ?? 1} step="1" onChange={v => set({ autocallFromPeriod: v })} />}
              {use.knockIn && <NumField id="ki" label="Knock-in barrier %" value={p.knockInBarrierPct} onChange={v => set({ knockInBarrierPct: v })} hint="Below it: final / strike in cash" />}
              {use.protection && <NumField id="prot" label="Protection %" value={p.protectionPct} onChange={v => set({ protectionPct: v })} />}
              {use.protection && <NumField id="part" label="Participation %" value={p.participationPct} onChange={v => set({ participationPct: v })} />}
            </div>
          </section>

          <section className="card">
            <h3>This issuance (pre-trade)</h3>
            <div className="form-grid">
              <NumField id="size" label="Size (units of 1 USDC)" value={size} step="1" onChange={setSize} />
              <div className="field"><label htmlFor="isin">ISIN / reference</label><input id="isin" value={isin} onChange={e => setIsin(e.target.value)} /></div>
              <div className="field">
                <label htmlFor="strike">Strike date (book closes)</label>
                <input id="strike" type="datetime-local" value={toLocalInput(strikeAt)} onChange={e => setStrikeAt(Math.floor(new Date(e.target.value).getTime() / 1000))} />
              </div>
              <div className="field">
                <label htmlFor="every">Observe every</label>
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  <input id="every" type="number" min={1} value={every.n} onChange={e => setEvery({ ...every, n: Number(e.target.value) || 1 })} style={{ width: 80 }} />
                  <select aria-label="Interval unit" value={every.unit} onChange={e => setEvery({ ...every, unit: e.target.value as typeof every.unit })}>
                    <option value="minutes">minutes (demo)</option><option value="days">days</option><option value="months">months</option>
                  </select>
                </div>
              </div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Observations: {obsTimes.map(t => new Date(t * 1000).toLocaleString()).join(' · ')}</p>
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <h3>Payout per 100 at maturity</h3>
            {errors.length ? <ul className="small" style={{ color: 'var(--bad)', margin: 0, paddingLeft: 18 }}>{errors.map(e => <li key={e}>{e}</li>)}</ul> : <PayoffChart params={p} />}
            {flat && <p className="small muted" style={{ margin: 0 }}>If {p.underlying.symbol} stays at the strike: {(totalPerUnit(flat) * 100).toFixed(2)} per 100{flat.calledAt ? `, called at observation ${flat.calledAt}` : ''}.</p>}
          </section>
          <section className="card">
            <h3>Coupon reserve</h3>
            <p className="small muted" style={{ margin: 0 }}>Deposited now so every coupon and the redemption can be paid on-chain: subscription proceeds cover par, the reserve covers what is paid above it{p.productType === 'ppn' ? ' (sized here for a 100% rise)' : ''}.</p>
            <div className="spread"><span>Reserve</span><span className="num">{fmtMoney(reserve)} USDC</span></div>
            <button className="btn accent" disabled={!connected || busy || errors.length > 0 || !(size > 0) || strikeAt < Date.now() / 1000 + 60} onClick={issue}>
              {connected ? (busy ? 'Issuing…' : 'Publish and open the book') : 'Connect a wallet to issue'}
            </button>
            {strikeAt < Date.now() / 1000 + 60 && <span className="small" style={{ color: 'var(--bad)' }}>The strike date must be at least a minute away.</span>}
            {progress.length > 0 && <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{progress.map(s => <li key={s}>{s}</li>)}</ol>}
            {error && <div className="notice err" role="alert">{error}</div>}
            <span className="small muted">Uses the devnet test USDC mint {DEPLOYMENT.testUsdc.slice(0, 6)}…; you need some in your wallet for the reserve.</span>
          </section>
        </aside>
      </div>
    </div>
  );
}
