/**
 * Subscribe from Ethereum Sepolia: tUSD and a "subscribe N units" call travel
 * to the note on Solana over Chainlink CCIP (about 30 minutes, Ethereum
 * finality included). The units are held for the investor's Sepolia address;
 * coupons and the redemption are sent back to it over CCIP.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Droplet, ExternalLink } from 'lucide-react';
import type { Address, Hex } from 'viem';
import { dec, encodeRun, ENGINE_PROGRAM_ID, receiveAccounts, slot, svmExtraArgs } from '@stratosnotes/flow';
import { ccipExplorer, SEPOLIA, TOKENS } from '../config';
import { connectSepolia, ccipSendToSolana, drip, hasEvmWallet, tokenBalance } from '../lib/evm';
import { saveInFlight, statusText, useInFlight } from '../lib/crosschain';
import { CASH, fmtDate, fmtMoney, type Offering } from '../lib/offerings';

/** A Sepolia subscription must arrive before the book closes: CCIP inbound takes ~30 min. */
export const SEPOLIA_LEAD_SEC = 40 * 60;

const hex = (u: Uint8Array) => ('0x' + Array.from(u, x => x.toString(16).padStart(2, '0')).join('')) as Hex;

export default function SepoliaSubscribe({ o, now, onSent }: { o: Offering; now: number; onSent: () => void }) {
  const [account, setAccount] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [units, setUnits] = useState('100');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const { list, status } = useInFlight(o.address.toBase58(), tick);
  const tusd = TOKENS.tUSD.sepolia;
  const remaining = Math.max(0, o.notional - o.sold);
  const cost = (Number(units) || 0) * o.params.issuePricePct / 100;
  const amount = BigInt(Math.round(cost * 10 ** tusd.decimals));
  const tooLate = o.strikeDate - now < SEPOLIA_LEAD_SEC;

  useEffect(() => {
    if (!account) return;
    tokenBalance(tusd.token as Address, account).then(setBalance).catch(() => setBalance(null));
  }, [account, tick, tusd.token]);

  const connect = async () => {
    setMsg(null);
    try { setAccount(await connectSepolia()); } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
  };
  const faucet = async () => {
    if (!account) return;
    setBusy('Claiming 2,000 test USD on Sepolia…'); setMsg(null);
    try { await drip(account, tusd.token as Address); setTick(t => t + 1); setMsg({ kind: 'ok', text: '2,000 tUSD received on Sepolia.' }); }
    catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message.split('\n')[0] : String(e) }); }
    finally { setBusy(''); }
  };
  const subscribe = async () => {
    if (!account) return;
    setMsg(null);
    try {
      const r = receiveAccounts(ENGINE_PROGRAM_ID, o.address, o.definition, o.process.mints[CASH], CASH);
      const { messageId, tx } = await ccipSendToSolana(account, {
        receiver: hex(ENGINE_PROGRAM_ID.toBytes()),
        data: hex(encodeRun(o.address, o.stepIndex.Task_Subscribe, [slot.number(dec(units))])),
        extraArgs: svmExtraArgs({ computeUnits: 400_000, writableBitmap: r.writableBitmap, tokenReceiver: r.tokenReceiver, accounts: r.accounts }) as Hex,
        token: tusd.token as Address,
        amount,
      }, setBusy);
      saveInFlight(o.address.toBase58(), { messageId, units: Number(units), sentAt: Math.floor(Date.now() / 1000), from: account, tx });
      setTick(t => t + 1);
      setMsg({ kind: 'ok', text: `Sent. ${units} units arrive on Solana in about 30 minutes, held for ${account.slice(0, 6)}…${account.slice(-4)}.` });
      onSent();
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message.split('\n')[0] : String(e) }); }
    finally { setBusy(''); }
  };

  return (
    <section className="card">
      <div className="spread"><h3>Subscribe from Ethereum Sepolia</h3><span className="pill plain">CCIP</span></div>
      <p className="xs muted">Pay in tUSD on Sepolia; Chainlink CCIP carries it and your subscription to this note on Solana in about 30 minutes. Coupons and the redemption are sent back to your Sepolia address.</p>
      {tooLate ? (
        <div className="notice warn">The book closes {fmtDate(o.strikeDate)}: too soon for a Sepolia subscription to arrive. Subscribe on Solana instead.</div>
      ) : !hasEvmWallet() ? (
        <div className="notice info">Install MetaMask (or another Ethereum wallet) to subscribe from Sepolia.</div>
      ) : !account ? (
        <button className="btn" onClick={connect}>Connect an Ethereum wallet</button>
      ) : (
        <>
          <div className="spread small">
            <span className="muted num">{account.slice(0, 6)}…{account.slice(-4)}</span>
            <span className="num">{balance === null ? '—' : fmtMoney(Number(balance) / 10 ** tusd.decimals)} tUSD</span>
          </div>
          <button className="btn" disabled={!!busy} onClick={faucet}><Droplet className="i" />Get test USD on Sepolia</button>
          <div className="field">
            <label htmlFor="s-units">Units</label>
            <input id="s-units" inputMode="decimal" value={units} onChange={e => setUnits(e.target.value)} />
            <span className="hint">You send {fmtMoney(cost)} tUSD plus the CCIP fee in Sepolia ETH. {fmtMoney(remaining, 0)} units left.</span>
          </div>
          <button className="btn primary" disabled={!!busy || !(Number(units) > 0) || Number(units) > remaining || (balance !== null && balance < amount)} onClick={subscribe}>
            {busy || <>Subscribe via CCIP <ArrowRight className="i" /></>}
          </button>
          <span className="xs muted">If it lands after the book closes, the tUSD is credited back to your Sepolia address instead: nothing is lost.</span>
        </>
      )}
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text}</div>}
      {list.length > 0 && (
        <div className="stack" style={{ gap: 6, borderTop: '1px solid hsl(var(--border))', paddingTop: 10 }}>
          <span className="label">Your Sepolia subscriptions</span>
          {list.map(m => {
            const s = statusText(status[m.messageId], m.sentAt, now);
            return (
              <div key={m.messageId} className="spread xs" style={{ alignItems: 'flex-start' }}>
                <span><strong>{m.units} units</strong> · <span style={{ color: s.failed ? 'hsl(var(--destructive))' : s.done ? 'hsl(var(--primary))' : 'hsl(var(--warning))' }}>{s.text}</span></span>
                <a href={ccipExplorer(m.messageId)} target="_blank" rel="noreferrer" className="row" style={{ gap: 3 }}>CCIP <ExternalLink className="i" style={{ width: 11, height: 11 }} /></a>
              </div>
            );
          })}
        </div>
      )}
      <span className="xs dim">Sepolia router {SEPOLIA.router.slice(0, 8)}… · lane Sepolia → Solana devnet</span>
    </section>
  );
}
