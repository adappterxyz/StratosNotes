import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { PRODUCT_LABELS, type ProductType } from '@stratosnotes/flow';
import { fmtMoney, headline, nextEvent, PHASE_LABEL, PHASES, toOffering, type Phase } from '../lib/offerings';
import { useNow, useOfferings } from '../lib/useOfferings';

/** Every note on the engine: open books first by default; finished lifecycles on request. */
export default function Marketplace() {
  const nav = useNavigate();
  const { offerings: raw, error } = useOfferings();
  const now = useNow();
  const offerings = useMemo(() => raw?.map(o => toOffering(o.process, o.def, now) ?? o), [raw, now]);
  const [phases, setPhases] = useState<Set<Phase>>(new Set(['book', 'fixing', 'live']));
  const [type, setType] = useState<'' | ProductType | 'custom'>('');
  const [und, setUnd] = useState('');
  const [q, setQ] = useState('');
  const symbols = useMemo(() => [...new Set((offerings ?? []).flatMap(o => o.unds.map(u => u.symbol)))].sort(), [offerings]);
  const counts = useMemo(() => Object.fromEntries(PHASES.map(p => [p, (offerings ?? []).filter(o => o.phase === p).length])) as Record<Phase, number>, [offerings]);

  const shown = (offerings ?? []).filter(o =>
    phases.has(o.phase)
    && (!type || (type === 'custom' ? o.custom : !o.custom && o.params.productType === type))
    && (!und || o.unds.some(u => u.symbol === und))
    && (!q || `${o.params.name} ${o.isin} ${o.address.toBase58()}`.toLowerCase().includes(q.toLowerCase())),
  );
  const toggle = (p: Phase) => setPhases(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Marketplace</h1>
          <p>Structured notes issued on Solana. Subscribe with USDC while a book is open; Chainlink CRE fixes the strike and observes every date, and coupons, autocalls and redemptions settle on-chain.</p>
        </div>
        <Link to="/issue" className="btn primary lg"><Plus className="i" />Issue a note</Link>
      </div>

      <div className="filters" role="group" aria-label="Filters">
        {PHASES.map(p => (
          <button key={p} className={`chip ${phases.has(p) ? 'on' : ''}`} aria-pressed={phases.has(p)} onClick={() => toggle(p)}>
            {PHASE_LABEL[p]} <span className="num dim">{counts[p] ?? 0}</span>
          </button>
        ))}
        <select aria-label="Product" value={type} onChange={e => setType(e.target.value as typeof type)}>
          <option value="">All products</option>
          {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(t => <option key={t} value={t}>{PRODUCT_LABELS[t]}</option>)}
          <option value="custom">Custom workflows</option>
        </select>
        <select aria-label="Underlying" value={und} onChange={e => setUnd(e.target.value)}>
          <option value="">All underlyings</option>
          {symbols.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input type="search" aria-label="Search" placeholder="Search name, ISIN or address" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      {error && <div className="notice err" role="alert">Could not read the chain: {error}</div>}

      {offerings === undefined ? <p className="muted">Reading notes from Solana…</p>
        : shown.length === 0 ? (
          <div className="empty">
            <strong>{offerings.length ? 'No notes match these filters.' : 'No notes issued yet.'}</strong>
            <span className="small">{phases.has('redeemed') ? 'Try another product or underlying.' : 'Completed notes are hidden: select Redeemed to include them.'}</span>
            <Link to="/issue" className="btn">Issue a note</Link>
          </div>
        ) : (
          <div className="card scroll-x" style={{ padding: 0 }}>
            <table className="t">
              <thead>
                <tr><th>Note</th><th>Underlying</th><th>Status</th><th className="r">Size</th><th style={{ minWidth: 140 }}>Subscribed</th><th className="r">Paid / unit</th><th>Next</th></tr>
              </thead>
              <tbody>
                {shown.map(o => {
                  const pct = o.notional ? Math.min(100, (o.sold / o.notional) * 100) : 0;
                  const go = () => nav(`/note/${o.address.toBase58()}`);
                  return (
                    <tr key={o.address.toBase58()} className="link" onClick={go}>
                      <td>
                        <Link to={`/note/${o.address.toBase58()}`} onClick={(e: { stopPropagation: () => void }) => e.stopPropagation()} style={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}>{o.params.name}</Link>
                        <div className="xs muted">{o.label}{o.hasTerms && !o.custom ? ` · ${headline(o.params)}` : ''}</div>
                      </td>
                      <td>{o.underlyingText}</td>
                      <td><span className={`pill ${o.phase}`}><span className="dot" />{PHASE_LABEL[o.phase]}</span></td>
                      <td className="r num">{fmtMoney(o.notional, 0)}</td>
                      <td>
                        <div className="bar"><span style={{ width: `${pct}%` }} /></div>
                        <div className="xs muted num" style={{ marginTop: 3 }}>{fmtMoney(o.sold, 0)} · {pct.toFixed(0)}%</div>
                      </td>
                      <td className="r num">{o.outcome ? o.outcome.perUnit.toFixed(4) : '—'}</td>
                      <td className="small muted">{nextEvent(o)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </main>
  );
}
