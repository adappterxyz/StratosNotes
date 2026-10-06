import { NavLink, Route, Routes, Link } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import Marketplace from './pages/Marketplace';
import OfferingPage from './pages/Offering';
import Issue from './pages/Issue';
import Portfolio from './pages/Portfolio';
import FaucetButton from './components/FaucetButton';
import { DEPLOYMENT, explorer } from './config';

export default function App() {
  return (
    <>
      <header className="top">
        <div className="top-inner">
          <Link to="/" className="brand" aria-label="StratosNotes home">
            <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0d1b2a" /><path d="M7 21 L13 13 L18 18 L25 9" stroke="#3ddc97" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            StratosNotes
          </Link>
          <nav className="nav">
            <NavLink to="/" end>Marketplace</NavLink>
            <NavLink to="/issue">Issue a note</NavLink>
            <NavLink to="/portfolio">Portfolio</NavLink>
          </nav>
          <span className="pill net"><span className="dot" style={{ color: 'var(--accent)' }} />Solana devnet</span>
          <FaucetButton />
          <WalletMultiButton />
        </div>
      </header>
      <main className="shell">
        <Routes>
          <Route path="/" element={<Marketplace />} />
          <Route path="/note/:address" element={<OfferingPage />} />
          <Route path="/issue" element={<Issue />} />
          <Route path="/portfolio" element={<Portfolio />} />
        </Routes>
        <footer className="foot">
          <span>Notes run as BPMN workflows on the StratosNotes engine; strikes and observations arrive as Chainlink CRE reports.</span>
          <a href={explorer('address', DEPLOYMENT.engine)} target="_blank" rel="noreferrer">Engine program</a>
        </footer>
      </main>
    </>
  );
}
