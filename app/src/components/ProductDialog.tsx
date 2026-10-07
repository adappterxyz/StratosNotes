/**
 * Term sheet -> workflow (Flow's ProductDialog). The issuer picks a payoff
 * and one underlying or a worst-of basket; the result opens on the canvas as
 * a stock product. Size and dates are not here: they are set per issuance, in
 * the Issue stage.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  EXAMPLE_PRODUCTS, FEEDS, MAX_UNDERLYINGS, PRODUCT_LABELS, productUses, simulatePerf, totalPerUnit, validateProductParams,
  type ProductParams, type ProductType,
} from '@stratosnotes/flow';
import PayoffChart from './PayoffChart';

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

export function ProductForm({ p, set }: { p: ProductParams; set: (patch: Partial<ProductParams>) => void }) {
  const use = productUses(p.productType);
  const pick = (t: ProductType) => set({ ...EXAMPLE_PRODUCTS[t], name: EXAMPLE_PRODUCTS[t].name, underlyings: p.underlyings, issuePricePct: p.issuePricePct });
  const symbols = p.underlyings.map(u => u.symbol);
  const toggleUnd = (k: keyof typeof FEEDS) => {
    if (symbols.includes(k)) { if (symbols.length > 1) set({ underlyings: p.underlyings.filter(u => u.symbol !== k) }); }
    else if (symbols.length < MAX_UNDERLYINGS) set({ underlyings: [...p.underlyings, FEEDS[k]] });
  };
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor="pd-type">Payoff</label>
        <select id="pd-type" value={p.productType} onChange={e => pick(e.target.value as ProductType)}>
          {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(t => <option key={t} value={t}>{PRODUCT_LABELS[t]}</option>)}
        </select>
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label htmlFor="pd-name">Name</label>
        <input id="pd-name" value={p.name} onChange={e => set({ name: e.target.value })} />
      </div>
      <div className="field wide">
        <span className="lbl">Underlying{symbols.length > 1 ? 's: worst of' : ''}</span>
        <div className="row" role="group" aria-label="Underlyings">
          {(Object.keys(FEEDS) as Array<keyof typeof FEEDS>).map(k => (
            <button key={k} type="button" className={`chip ${symbols.includes(k) ? 'on' : ''}`} aria-pressed={symbols.includes(k)} onClick={() => toggleUnd(k)}
              disabled={!symbols.includes(k) && symbols.length >= MAX_UNDERLYINGS}>
              {k}/USD
            </button>
          ))}
        </div>
        <span className="hint">{symbols.length > 1
          ? `Worst-of: every barrier, autocall and the redemption use the weakest of ${symbols.join(', ')} against its own strike. Up to ${MAX_UNDERLYINGS}.`
          : 'Pick more than one for a worst-of basket. Chainlink price feeds, read by CRE.'}</span>
      </div>
      <NumField id="pd-obs" label="Observations" value={p.observations} step="1" onChange={v => set({ observations: v, ...(p.autocallFromPeriod && p.autocallFromPeriod > v ? { autocallFromPeriod: 1 } : {}) })} hint="The last is maturity" />
      <NumField id="pd-price" label="Issue price %" value={p.issuePricePct} onChange={v => set({ issuePricePct: v })} />
      {use.coupon && <NumField id="pd-cpn" label={p.productType === 'snowball' ? 'Accrued coupon / period %' : 'Coupon / period %'} value={p.couponRatePct} onChange={v => set({ couponRatePct: v })} />}
      {use.couponBarrier && <NumField id="pd-cb" label="Coupon barrier %" value={p.couponBarrierPct} onChange={v => set({ couponBarrierPct: v })} />}
      {use.couponBarrier && (
        <div className="field"><label htmlFor="pd-mem">Memory coupon</label>
          <select id="pd-mem" value={p.memory ? 'yes' : 'no'} onChange={e => set({ memory: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select>
        </div>
      )}
      {use.autocall && <NumField id="pd-ac" label="Autocall level %" value={p.autocallLevelPct} onChange={v => set({ autocallLevelPct: v })} />}
      {use.autocall && <NumField id="pd-acf" label="Autocall from observation" value={p.autocallFromPeriod ?? 1} step="1" onChange={v => set({ autocallFromPeriod: v })} />}
      {use.knockIn && <NumField id="pd-ki" label="Knock-in barrier %" value={p.knockInBarrierPct} onChange={v => set({ knockInBarrierPct: v })} hint="Below it: final / strike in cash" />}
      {use.protection && <NumField id="pd-prot" label="Protection %" value={p.protectionPct} onChange={v => set({ protectionPct: v })} />}
      {use.protection && <NumField id="pd-part" label="Participation %" value={p.participationPct} onChange={v => set({ participationPct: v })} />}
    </div>
  );
}

export default function ProductDialog({ initial, onClose, onCreate }: { initial: ProductParams | null; onClose: () => void; onCreate: (p: ProductParams) => void }) {
  const [p, setP] = useState<ProductParams>(initial ?? EXAMPLE_PRODUCTS.phoenix);
  useEffect(() => { if (initial) setP(initial); }, [initial]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  const errors = validateProductParams(p);
  const flat = errors.length ? null : simulatePerf(p, new Array(p.observations).fill(1));
  return (
    <div className="scrim" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pd-title" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2 id="pd-title">Structured product</h2>
            <p className="xs muted">A verified payoff engine from a term sheet. Size, strike date and observation dates are set when you issue.</p>
          </div>
          <button className="btn" onClick={onClose} aria-label="Close"><X className="i" /></button>
        </div>
        <div className="modal-body">
          <div className="modal-cols">
            <ProductForm p={p} set={patch => setP(prev => ({ ...prev, ...patch }))} />
            <div className="stack" style={{ gap: 8 }}>
              <span className="label">Payout per 100 at maturity</span>
              {errors.length
                ? <ul className="issues">{errors.map(e => <li key={e} className="err">{e}</li>)}</ul>
                : <PayoffChart params={p} />}
              {flat && <p className="xs muted">If {p.underlyings.length > 1 ? 'every underlying stays' : `${p.underlyings[0].symbol} stays`} at its strike: {(totalPerUnit(flat) * 100).toFixed(2)} per 100{flat.calledAt ? `, called at observation ${flat.calledAt}` : ''}.</p>}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={errors.length > 0} onClick={() => onCreate(p)}>Open workflow</button>
        </div>
      </div>
    </div>
  );
}
