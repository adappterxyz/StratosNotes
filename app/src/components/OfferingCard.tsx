import { Link } from 'react-router-dom';
import { fmtDate, fmtMoney, fmtPrice, type Offering } from '../lib/offerings';

export const PHASE_LABEL: Record<Offering['phase'], string> = {
  book: 'Book open', fixing: 'Fixing strike', live: 'Live', redeemed: 'Redeemed',
};

/** One line describing the payoff, from the term sheet. */
export function headline(o: Offering['params']) {
  const parts: string[] = [];
  if (o.couponRatePct) parts.push(`${o.couponRatePct}% ${o.productType === 'snowball' ? 'accrued' : 'coupon'} / period`);
  if (o.couponBarrierPct) parts.push(`coupon barrier ${o.couponBarrierPct}%${o.memory ? ' (memory)' : ''}`);
  if (o.autocallLevelPct) parts.push(`autocall ${o.autocallLevelPct}%`);
  if (o.knockInBarrierPct) parts.push(`knock-in ${o.knockInBarrierPct}%`);
  if (o.protectionPct) parts.push(`${o.protectionPct}% protected, ${o.participationPct}% participation`);
  return parts.join(' · ');
}

export default function OfferingCard({ o }: { o: Offering }) {
  const sold = o.notional ? Math.min(100, (o.sold / o.notional) * 100) : 0;
  const next = o.phase === 'book' ? `Strike ${fmtDate(o.strikeDate)}`
    : o.phase === 'live' ? (o.obsDates[o.observed.length] ? `Next observation ${fmtDate(o.obsDates[o.observed.length])}` : 'Maturing')
    : o.phase === 'fixing' ? 'Waiting for the CRE strike fixing' : o.outcome?.calledAt ? `Autocalled at observation ${o.outcome.calledAt}` : 'Matured';
  return (
    <Link to={`/note/${o.address.toBase58()}`} className="card">
      <div className="card-head">
        <div style={{ display: 'grid', gap: 4 }}>
          <span className="label">{o.label} · {o.params.underlying.symbol}/USD</span>
          <h3>{o.params.name}</h3>
        </div>
        <span className={`pill ${o.phase}`}><span className="dot" />{PHASE_LABEL[o.phase]}</span>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{headline(o.params)}</p>
      <div className="kv">
        <div><span className="label">Size</span><span className="v">{fmtMoney(o.notional, 0)}</span></div>
        <div><span className="label">Issue price</span><span className="v">{o.params.issuePricePct}%</span></div>
        <div><span className="label">Strike</span><span className="v">{o.strike === null ? '—' : fmtPrice(o.strike)}</span></div>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="spread small"><span className="muted">{fmtMoney(o.sold, 0)} of {fmtMoney(o.notional, 0)} subscribed</span><span className="num">{sold.toFixed(0)}%</span></div>
        <div className="bar"><span style={{ width: `${sold}%` }} /></div>
      </div>
      <div className="small muted">{next}</div>
    </Link>
  );
}
