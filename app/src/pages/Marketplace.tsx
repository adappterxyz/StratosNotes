import { Link } from 'react-router-dom';
import OfferingCard from '../components/OfferingCard';
import { useOfferings } from '../lib/useOfferings';

export default function Marketplace() {
  const { offerings, error } = useOfferings();
  const open = offerings?.filter(o => o.phase === 'book') ?? [];
  const running = offerings?.filter(o => o.phase !== 'book') ?? [];
  return (
    <div className="stack">
      <section className="hero">
        <span className="label">Structured notes marketplace</span>
        <h1>Issue a structured note in minutes. Subscribe with USDC. Chainlink CRE observes the rest.</h1>
        <p>Each note is a BPMN workflow (issuer, paying agent, investors) running on one Solana program. Pre-trade terms are fixed per issuance; Chainlink CRE fixes the strike and observes the underlying on every date; coupons, autocalls and redemptions settle on-chain.</p>
        <div className="flowline">
          <span className="step">Term sheet</span>→<span className="step">BPMN workflow</span>→<span className="step">Book opens</span>→<span className="step">CRE fixes strike</span>→<span className="step">CRE observes</span>→<span className="step">Coupons · autocall · redemption</span>
        </div>
      </section>

      {error && <div className="notice err" role="alert">Could not read the chain: {error}</div>}

      <section className="stack">
        <div className="spread"><h2>Open for subscription</h2><Link to="/issue" className="small">Issue your own note →</Link></div>
        {offerings === null ? <p className="muted">Reading offerings from Solana…</p>
          : open.length ? <div className="grid">{open.map(o => <OfferingCard key={o.address.toBase58()} o={o} />)}</div>
          : <div className="empty"><strong>No books open right now.</strong><span className="small">Issue a note to open one; investors can subscribe until its strike date.</span><Link to="/issue" className="btn">Issue a note</Link></div>}
      </section>

      {running.length > 0 && (
        <section className="stack">
          <h2>Live and redeemed</h2>
          <div className="grid">{running.map(o => <OfferingCard key={o.address.toBase58()} o={o} />)}</div>
        </section>
      )}
    </div>
  );
}
