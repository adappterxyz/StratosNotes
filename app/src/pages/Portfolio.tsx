import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { toBase } from '@stratosnotes/flow';
import { explorer } from '../config';
import { useEngine } from '../lib/engine';
import { CASH, fmtMoney, PHASE_LABEL, position } from '../lib/offerings';
import { useOfferings } from '../lib/useOfferings';

export default function Portfolio() {
  const { publicKey } = useWallet();
  const { engine } = useEngine();
  const { offerings, refresh } = useOfferings();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);

  if (!publicKey) return <main className="page"><div className="empty"><strong>Connect a wallet to see your notes.</strong><span className="small">Positions, coupons received and cash you can withdraw, across every issuance.</span></div></main>;
  if (!offerings) return <main className="page"><p className="muted">Reading your positions from Solana…</p></main>;

  const rows = offerings
    .map(o => ({ o, pos: position(o, publicKey), issuer: o.issuer.equals(publicKey) }))
    .filter(r => r.pos.units > 0 || r.pos.cash > 0 || r.issuer);
  const withdraw = async (r: typeof rows[number]) => {
    setBusy(r.o.address.toBase58()); setMsg(null);
    try {
      const sig = await engine.send([await engine.withdraw(r.o.address, r.o.definition, CASH, r.o.process.mints[CASH], toBase(r.pos.cashRaw, 6))]);
      setMsg({ kind: 'ok', text: `Withdrew ${fmtMoney(r.pos.cash)} USDC from ${r.o.params.name}.`, sig });
      refresh();
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(''); }
  };

  return (
    <main className="page">
      <div className="page-head"><div><h1>Portfolio</h1><p>Notes you hold or issued, and the cash each one owes you.</p></div></div>
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.sig && <a href={explorer('tx', msg.sig)} target="_blank" rel="noreferrer">View transaction</a>}</div>}
      {rows.length === 0 ? (
        <div className="empty"><strong>No positions yet.</strong><Link to="/" className="btn">Browse open books</Link></div>
      ) : (
        <div className="card scroll-x" style={{ padding: 0 }}>
          <table className="t">
            <thead><tr><th>Note</th><th>Role</th><th>Status</th><th className="r">Units</th><th className="r">Cash to withdraw</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.o.address.toBase58()}>
                  <td><Link to={`/note/${r.o.address.toBase58()}`}>{r.o.params.name}</Link><br /><span className="small muted">{r.o.isin}</span></td>
                  <td>{r.issuer ? 'Issuer' : 'Investor'}</td>
                  <td><span className={`pill ${r.o.phase}`}><span className="dot" />{PHASE_LABEL[r.o.phase]}</span></td>
                  <td className="r num">{fmtMoney(r.pos.units)}</td>
                  <td className="r num">{fmtMoney(r.pos.cash)}</td>
                  <td className="r"><button className="btn" disabled={!(r.pos.cash > 0) || !!busy} onClick={() => withdraw(r)}>{busy === r.o.address.toBase58() ? 'Withdrawing…' : 'Withdraw'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
