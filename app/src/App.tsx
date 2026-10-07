import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Briefcase, LayoutGrid, Moon, PenTool, Sun } from 'lucide-react';
import Marketplace from './pages/Marketplace';
import OfferingPage from './pages/Offering';
import Portfolio from './pages/Portfolio';
import Workspace from './pages/Workspace';
import FaucetButton from './components/FaucetButton';
import { DEPLOYMENT, explorer } from './config';

function ThemeToggle() {
  const [light, setLight] = useState(() => document.documentElement.classList.contains('light'));
  useEffect(() => {
    document.documentElement.classList.toggle('light', light);
    try { localStorage.setItem('sn-theme', light ? 'light' : 'dark'); } catch { /* private mode */ }
  }, [light]);
  return (
    <button className="btn" onClick={() => setLight(l => !l)} aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'} title={light ? 'Dark theme' : 'Light theme'}>
      {light ? <Moon className="i" /> : <Sun className="i" />}
    </button>
  );
}

export default function App() {
  const { pathname } = useLocation();
  const workspace = pathname.startsWith('/issue');
  return (
    <>
      <header className="appbar">
        <Link to="/" className="brand" aria-label="StratosNotes marketplace">
          <img src="/logos/stratos-mark.png" alt="" width={22} height={22} />
          StratosNotes
        </Link>
        <nav className="seg" aria-label="Sections">
          <NavLink to="/" end><LayoutGrid className="i" />Marketplace</NavLink>
          <NavLink to="/issue"><PenTool className="i" />Issue</NavLink>
          <NavLink to="/portfolio"><Briefcase className="i" />Portfolio</NavLink>
        </nav>
        <div className="right">
          <span className="pill plain" title="Every note runs on the StratosNotes engine on Solana devnet"><span className="dot" style={{ color: 'hsl(var(--primary))' }} />Solana devnet</span>
          <FaucetButton />
          <WalletMultiButton />
          <ThemeToggle />
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Marketplace />} />
        <Route path="/note/:address" element={<OfferingPage />} />
        <Route path="/issue" element={<Workspace />} />
        <Route path="/studio" element={<Navigate to="/issue" replace />} />
        <Route path="/portfolio" element={<Portfolio />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {!workspace && (
        <footer className="foot">
          <span>Notes run as BPMN workflows on the StratosNotes engine; strikes and observations arrive as Chainlink CRE reports.</span>
          <a href={explorer('address', DEPLOYMENT.engine)} target="_blank" rel="noreferrer">Engine program</a>
          <a href="/">About StratosNotes</a>
        </footer>
      )}
    </>
  );
}
