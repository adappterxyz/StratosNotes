/**
 * Switch between the built-in demo wallets (issuer and investor) in one click,
 * so a single person can issue a note and then subscribe to it. Any other
 * wallet (Phantom, Solflare…) is still chosen from the wallet button.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import { DEMO_WALLETS, type DemoRole } from '../lib/demoWallet';

const ROLES: Array<{ role: DemoRole; label: string }> = [
  { role: 'issuer', label: 'Issuer' },
  { role: 'investor', label: 'Investor' },
];

export default function RoleSwitch() {
  const { wallet, select, connecting } = useWallet();
  const active = ROLES.find(r => wallet?.adapter.name === DEMO_WALLETS[r.role])?.role;
  return (
    <div className="seg role-switch" role="group" aria-label="Demo wallet" title="Built-in devnet wallets: they sign without pop-ups and their keys stay in this browser">
      <span className="xs muted" style={{ padding: '0 6px' }}>Demo</span>
      {ROLES.map(r => (
        <button key={r.role} className={active === r.role ? 'active' : ''} aria-pressed={active === r.role} disabled={connecting}
          onClick={() => { if (active !== r.role) select(DEMO_WALLETS[r.role]); }}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
