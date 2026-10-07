/**
 * Who holds what in a note: note units, cash and delivered tokens, on Solana
 * or on Sepolia (remote holders, who subscribed over CCIP). A Sepolia
 * holder's balances go home over CCIP; anyone can send them (their Solana
 * wallet pays the CCIP fee in SOL).
 */
import { useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { ExternalLink, Send } from 'lucide-react';
import { remoteOf, SCALE } from '@stratosnotes/flow';
import { explorer, SEPOLIA, tokenByMint } from '../config';
import { useEngine } from '../lib/engine';
import { buildWithdrawRemote } from '../lib/crosschain';
import { fmtMoney, NOTE, short, type Offering } from '../lib/offerings';

export default function HoldersPanel({ o, onDone }: { o: Offering; onDone: () => void }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { engine } = useEngine();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);

  const label = (asset: number) => asset === NOTE ? 'units' : tokenByMint(o.process.mints[asset].toBase58())?.symbol ?? o.def.assets[asset]?.name ?? `asset ${asset}`;
  const owners = [...new Set(o.process.holdings.filter(h => h.amount > 0n).map(h => h.owner.toBase58()))];
  const rows = owners.map(k => {
    const hs = o.process.holdings.filter(h => h.owner.toBase58() === k && h.amount > 0n);
    const remote = remoteOf(hs[0].owner);
    return { key: hs[0].owner, remote, role: hs[0].owner.equals(o.issuer) ? 'Issuer' : null, hs };
  }).sort((a, b) => Number(!!a.role) - Number(!!b.role));
  if (!rows.length) return null;

  const send = async (holder: (typeof rows)[number], asset: number) => {
    const sym = tokenByMint(o.process.mints[asset].toBase58())?.symbol;
    if (!publicKey || !sym) return;
    const id = `${holder.key.toBase58()}:${asset}`;
    setBusy(id); setMsg(null);
    try {
      const tx = await buildWithdrawRemote({ connection, engine, payer: publicKey, process: o.address, definition: o.definition, holder: holder.key, asset, symbol: sym });
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(sig, 'confirmed');
      setMsg({ kind: 'ok', text: `Sent to ${holder.remote!.address.slice(0, 6)}…${holder.remote!.address.slice(-4)} on Sepolia: it arrives in about a minute.`, sig });
      onDone();
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message.split('\n')[0] : String(e) }); }
    finally { setBusy(''); }
  };

  return (
    <section className="card">
      <div className="spread"><h3>Holders</h3><span className="xs muted">Solana and Sepolia (CCIP)</span></div>
      <div className="scroll-x">
        <table className="t">
          <thead><tr><th>Holder</th><th className="r">Balances</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key.toBase58()}>
                <td>
                  {r.remote
                    ? <a href={`${SEPOLIA.explorer}/address/${r.remote.address}`} target="_blank" rel="noreferrer" className="num">{r.remote.address.slice(0, 6)}…{r.remote.address.slice(-4)}</a>
                    : <a href={explorer('address', r.key.toBase58())} target="_blank" rel="noreferrer" className="num">{short(r.key)}</a>}
                  <div className="xs"><span className={`pill ${r.remote ? 'live' : 'plain'}`} style={{ fontSize: 10 }}>{r.remote ? 'Sepolia' : 'Solana'}</span>{r.role && <span className="xs muted"> · {r.role}</span>}{publicKey && r.key.equals(publicKey) && <span className="xs muted"> · you</span>}</div>
                </td>
                <td className="r">
                  {r.hs.map(h => (
                    <div key={h.asset} className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <span className="num small">{fmtMoney(Number(h.amount) / Number(SCALE), h.asset === NOTE ? 0 : 4)} {label(h.asset)}</span>
                      {r.remote && h.asset !== NOTE && (
                        <button className="btn" style={{ padding: '2px 8px' }} disabled={!publicKey || !!busy} onClick={() => send(r, h.asset)} title="Send to this holder's Sepolia address over CCIP (your Solana wallet pays the fee)">
                          <Send className="i" style={{ width: 12, height: 12 }} />{busy === `${r.key.toBase58()}:${h.asset}` ? 'Sending…' : 'Send'}
                        </button>
                      )}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.sig && <a href={`https://ccip.chain.link/tx/${msg.sig}`} target="_blank" rel="noreferrer">Follow on CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>}</div>}
    </section>
  );
}
