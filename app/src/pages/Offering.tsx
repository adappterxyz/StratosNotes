import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { ArrowLeft, Radio } from 'lucide-react';
import { dec, defToBpmn, instantiateProduct, slot, slotValue, SCALE, toBase } from '@stratosnotes/flow';
import TasksPanel from '../components/TasksPanel';
import BpmnView from '../components/BpmnView';
import PayoffChart from '../components/PayoffChart';
import { explorer } from '../config';
import { useEngine } from '../lib/engine';
import { CASH, fmtDate, fmtMoney, fmtPct, fmtPrice, headline, PHASE_LABEL, position, short, toOffering } from '../lib/offerings';
import { useNow, useOffering } from '../lib/useOfferings';

export default function OfferingPage() {
  const { address } = useParams();
  const { offering: loaded, refresh, updatedAt } = useOffering(address);
  const now = useNow(1000);
  // Phases move with the clock (the book closes at the strike date) as well as with the chain.
  const o = useMemo(() => (loaded ? toOffering(loaded.process, loaded.def, now) : loaded), [loaded, Math.floor(now / 5)]); // eslint-disable-line react-hooks/exhaustive-deps
  const { engine, connected } = useEngine();
  const { publicKey } = useWallet();
  const [units, setUnits] = useState('100');
  const [xfer, setXfer] = useState({ to: '', units: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);
  // Stock products redraw from their term sheet; custom workflows from the on-chain definition.
  const xml = useMemo(() => (!o ? '' : o.custom ? defToBpmn(o.def) : instantiateProduct(o.params).bpmnXml), [o?.definition.toBase58(), o?.custom]); // eslint-disable-line react-hooks/exhaustive-deps

  if (o === undefined) return <main className="page"><p className="muted">Reading the note from Solana…</p></main>;
  if (o === null) return <main className="page"><div className="empty"><strong>No note at this address.</strong><Link to="/">Back to the marketplace</Link></div></main>;

  const mine = publicKey ? position(o, publicKey) : null;
  const remaining = Math.max(0, o.notional - o.sold);
  const cost = (Number(units) || 0) * o.params.issuePricePct / 100;
  const run = async (what: string, f: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { const sig = await f(); setMsg({ kind: 'ok', text: what, sig }); refresh(); }
    catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const subscribe = () => run(`Subscribed ${units} units for ${fmtMoney(cost)} USDC.`, async () =>
    engine.send([await engine.executeStep(o.address, o.definition, o.stepIndex.Task_Subscribe, [slot.number(dec(units))], { deposit: { asset: CASH, mint: o.process.mints[CASH] } })]));
  const transfer = () => run(`Transferred ${xfer.units} units.`, async () => {
    let to: PublicKey;
    try { to = new PublicKey(xfer.to.trim()); } catch { throw new Error('Enter the recipient wallet address.'); }
    return engine.send([await engine.transferUnits(o.address, o.definition, 0, to, dec(xfer.units))]);
  });
  const withdraw = () => run('Withdrawn to your wallet.', async () =>
    engine.send([await engine.withdraw(o.address, o.definition, CASH, o.process.mints[CASH], toBase(mine!.cashRaw, 6))]));

  const basket = o.unds.length > 1;
  const levels = (k: number) => o.unds.map(u => `${u.symbol} ${fmtPrice(u.observed[k])}`).join(' · ');
  const events: Array<{ label: string; when: number; value?: string; state: 'done' | 'now' | 'later' }> = o.hasTerms ? [
    {
      label: 'Book closes, strike fixed by CRE', when: o.strikeDate,
      value: o.strikeFixed ? o.unds.map(u => `${basket ? `${u.symbol} ` : ''}${fmtPrice(u.strike!)}`).join(' · ') : undefined,
      state: o.strikeFixed ? 'done' : o.phase === 'fixing' ? 'now' : 'later',
    },
    ...o.obsDates.map((t, k) => ({
      label: k === o.obsDates.length - 1 ? 'Final observation (maturity)' : `Observation ${k + 1}`,
      when: t,
      value: o.perfs[k] !== undefined ? (basket ? `worst ${fmtPct(o.perfs[k])} (${levels(k)})` : `${fmtPrice(o.unds[0].observed[k])} (${fmtPct(o.perfs[k])})`) : undefined,
      state: (o.perfs[k] !== undefined ? 'done' : o.phase === 'live' && k === o.perfs.length ? 'now' : 'later') as 'done' | 'now' | 'later',
      ...(o.phase === 'redeemed' && o.perfs[k] === undefined ? { value: o.outcome?.calledAt ? `not needed: called at ${o.outcome.calledAt}` : 'not observed' } : {}),
    })),
  ] : [];
  const secsAgo = Math.max(0, Math.round(now - updatedAt / 1000));

  return (
    <main className="page">
      <Link to="/" className="small row" style={{ gap: 4 }}><ArrowLeft className="i" />Marketplace</Link>
      <div className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">{o.label} · {o.underlyingText}{o.isin ? ` · ${o.isin}` : ''}</span>
          <div className="row"><h1>{o.params.name}</h1><span className={`pill ${o.phase}`}><span className="dot" />{PHASE_LABEL[o.phase]}</span></div>
          {o.hasTerms && <p className="small muted">{headline(o.params)}</p>}
        </div>
        <span className="pill plain" title="This page follows the note's account on Solana and updates when anything happens: a CRE report, a subscription, a transfer.">
          <Radio className="i" style={{ width: 12, height: 12, color: 'hsl(var(--primary))' }} />Live · updated {secsAgo < 5 ? 'just now' : `${secsAgo}s ago`}
        </span>
      </div>

      <div className="two">
        <div className="stack">
          <section className="card">
            <div className="kv">
              <div><span className="label">Size</span><span className="v">{fmtMoney(o.notional, 0)} USDC</span></div>
              <div><span className="label">Subscribed</span><span className="v">{fmtMoney(o.sold, 0)}</span></div>
              <div><span className="label">Issue price</span><span className="v">{o.params.issuePricePct}%</span></div>
              <div><span className="label">Observations</span><span className="v">{o.params.observations}</span></div>
              <div><span className="label">{basket ? 'Worst performance' : 'Performance'}</span><span className="v">{o.perfs.length ? fmtPct(o.perfs[o.perfs.length - 1]) : '—'}</span></div>
              <div><span className="label">Paid so far / unit</span><span className="v">{o.outcome ? o.outcome.perUnit.toFixed(4) : '—'}</span></div>
            </div>
            {o.unds.length > 0 && (
              <div className="scroll-x">
                <table className="t">
                  <thead><tr><th>Underlying</th><th className="r">Strike</th><th className="r">Last observed</th><th className="r">Performance</th></tr></thead>
                  <tbody>
                    {o.unds.map(u => {
                      const last = u.observed[u.observed.length - 1];
                      return (
                        <tr key={u.symbol}>
                          <td>{u.symbol}/USD <span className="xs dim num" title={u.feed}>{short(u.feed)}</span></td>
                          <td className="r num">{u.strike === null ? '—' : fmtPrice(u.strike)}</td>
                          <td className="r num">{last === undefined ? '—' : fmtPrice(last)}</td>
                          <td className="r num">{last === undefined || u.strike === null ? '—' : fmtPct(last / u.strike)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {events.length > 0 && (
            <section className="card">
              <h3>Schedule: set at pre-trade, observed by Chainlink CRE</h3>
              <div className="timeline">
                {events.map(e => (
                  <div key={e.label} className={`tl ${e.state}`}>
                    <span className="mark" />
                    <span>{e.label}<br /><span className="xs muted">{fmtDate(e.when)}</span></span>
                    <span className="num small" style={{ textAlign: 'right' }}>{e.value ?? (e.state === 'now' ? (now >= e.when ? 'due: waiting for CRE' : 'next') : '')}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="stack" style={{ gap: 8 }}>
            <div className="spread"><h3>Workflow</h3><span className="xs muted">Highlighted: where this note is now</span></div>
            <BpmnView xml={xml} active={o.activeSteps} />
          </section>
        </div>

        <aside className="stack">
          {o.phase === 'book' && !o.custom && o.stepIndex.Task_Subscribe !== undefined && (
            <section className="card">
              <h3>Subscribe</h3>
              <p className="small muted">Open until {fmtDate(o.strikeDate)}. {fmtMoney(remaining, 0)} units left; one unit is 1 USDC of face.</p>
              <div className="field">
                <label htmlFor="units">Units</label>
                <input id="units" inputMode="decimal" value={units} onChange={e => setUnits(e.target.value)} />
                <span className="hint">You pay {fmtMoney(cost)} USDC, delivered against note units in one transaction.</span>
              </div>
              <button className="btn primary lg" disabled={!connected || busy || !(Number(units) > 0) || Number(units) > remaining} onClick={subscribe}>
                {connected ? (busy ? 'Subscribing…' : 'Subscribe') : 'Connect a wallet to subscribe'}
              </button>
            </section>
          )}

          <TasksPanel o={o} onDone={refresh} hide={o.custom ? [] : ['Task_Subscribe']} />

          {mine && (mine.units > 0 || mine.cash > 0) && (
            <section className="card">
              <h3>Your position</h3>
              <div className="kv">
                <div><span className="label">Note units</span><span className="v">{fmtMoney(mine.units)}</span></div>
                <div><span className="label">Cash to withdraw</span><span className="v">{fmtMoney(mine.cash)}</span></div>
              </div>
              <button className="btn" disabled={busy || !(mine.cash > 0)} onClick={withdraw}>Withdraw USDC</button>
              {mine.units > 0 && o.phase !== 'redeemed' && (
                <div className="stack" style={{ gap: 8, borderTop: '1px solid hsl(var(--border))', paddingTop: 10 }}>
                  <span className="label">Transfer notes</span>
                  <div className="field"><label htmlFor="x-to">To wallet</label><input id="x-to" className="num" value={xfer.to} onChange={e => setXfer({ ...xfer, to: e.target.value })} placeholder="Solana address" /></div>
                  <div className="field"><label htmlFor="x-units">Units (up to {fmtMoney(mine.units)})</label><input id="x-units" inputMode="decimal" value={xfer.units} onChange={e => setXfer({ ...xfer, units: e.target.value })} /></div>
                  <button className="btn" disabled={busy || !(Number(xfer.units) > 0) || Number(xfer.units) > mine.units} onClick={transfer}>Transfer</button>
                  <span className="xs muted">In whole or in part. Coupons and the redemption from now on go to whoever holds the units.</span>
                </div>
              )}
            </section>
          )}

          {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.sig && <a href={explorer('tx', msg.sig)} target="_blank" rel="noreferrer">View transaction</a>}</div>}

          {o.custom && (
            <section className="card">
              <h3>Workflow fields</h3>
              <table className="t"><tbody>
                {o.def.fields.map((f, i) => {
                  const v = slotValue(o.process.values[i], f.kind);
                  const shown = v === null ? '—' : typeof v === 'bigint' ? (f.kind === 0 ? (Number(v) / Number(SCALE)).toLocaleString() : f.kind === 2 ? new Date(Number(v) * 1000).toLocaleString() : v.toString()) : String(v);
                  return <tr key={f.name}><td>{f.name}</td><td className="r num">{shown}</td></tr>;
                })}
              </tbody></table>
            </section>
          )}

          {!o.custom && (
            <section className="card">
              <h3>Payout per 100 at maturity</h3>
              <PayoffChart params={o.params} />
              <p className="xs muted">Against the final {basket ? 'worst performance' : 'level'}, % of strike, if not called earlier. Dashed lines: barriers.</p>
            </section>
          )}

          <section className="card small">
            <div className="spread"><span className="muted">Issuance</span><a className="num" href={explorer('address', o.address.toBase58())} target="_blank" rel="noreferrer">{short(o.address)}</a></div>
            <div className="spread"><span className="muted">Workflow definition</span><a className="num" href={explorer('address', o.definition.toBase58())} target="_blank" rel="noreferrer">{short(o.definition)}</a></div>
            <div className="spread"><span className="muted">Issuer</span><span className="num">{short(o.issuer)}</span></div>
          </section>
        </aside>
      </div>
    </main>
  );
}
