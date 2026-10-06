import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { dec, instantiateProduct, slot, toBase } from '@stratosnotes/flow';
import BpmnView from '../components/BpmnView';
import PayoffChart from '../components/PayoffChart';
import { headline, PHASE_LABEL } from '../components/OfferingCard';
import { explorer } from '../config';
import { useEngine } from '../lib/engine';
import { CASH, fmtDate, fmtMoney, fmtPrice, position } from '../lib/offerings';
import { useOfferings } from '../lib/useOfferings';

export default function OfferingPage() {
  const { address } = useParams();
  const { offerings, refresh } = useOfferings();
  const { engine, connected } = useEngine();
  const { publicKey } = useWallet();
  const o = offerings?.find(x => x.address.toBase58() === address);
  const [units, setUnits] = useState('100');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);
  const xml = useMemo(() => (o ? instantiateProduct(o.params).bpmnXml : ''), [o?.params]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!offerings) return <p className="muted" style={{ paddingTop: 32 }}>Reading the note from Solana…</p>;
  if (!o) return <div className="empty" style={{ marginTop: 32 }}><strong>No note at this address.</strong><Link to="/">Back to the marketplace</Link></div>;

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
  const withdraw = () => run('Withdrawn to your wallet.', async () =>
    engine.send([await engine.withdraw(o.address, o.definition, CASH, o.process.mints[CASH], toBase(mine!.cashRaw, 6))]));

  const events: Array<{ label: string; when: number; value?: string; state: 'done' | 'now' | 'later' }> = [
    { label: 'Book closes, strike fixed by CRE', when: o.strikeDate, value: o.strike === null ? undefined : fmtPrice(o.strike), state: o.strike !== null ? 'done' : o.phase === 'fixing' ? 'now' : 'later' },
    ...o.obsDates.map((t, k) => ({
      label: k === o.obsDates.length - 1 ? 'Final observation (maturity)' : `Observation ${k + 1}`,
      when: t,
      value: o.observed[k] !== undefined ? `${fmtPrice(o.observed[k])} (${((o.observed[k] / o.strike!) * 100).toFixed(1)}%)` : undefined,
      state: (o.observed[k] !== undefined ? 'done' : o.phase === 'live' && k === o.observed.length ? 'now' : 'later') as 'done' | 'now' | 'later',
    })),
  ];

  return (
    <div className="stack" style={{ paddingTop: 28 }}>
      <div className="stack" style={{ gap: 8 }}>
        <span className="label">{o.label} · {o.params.underlying.symbol}/USD · {o.isin}</span>
        <div className="row"><h1>{o.params.name}</h1><span className={`pill ${o.phase}`}><span className="dot" />{PHASE_LABEL[o.phase]}</span></div>
        <p className="muted" style={{ margin: 0 }}>{headline(o.params)}</p>
      </div>

      <div className="two">
        <div className="stack">
          <section className="card">
            <div className="kv">
              <div><span className="label">Size</span><span className="v">{fmtMoney(o.notional, 0)} USDC</span></div>
              <div><span className="label">Subscribed</span><span className="v">{fmtMoney(o.sold, 0)}</span></div>
              <div><span className="label">Issue price</span><span className="v">{o.params.issuePricePct}%</span></div>
              <div><span className="label">Strike</span><span className="v">{o.strike === null ? '—' : fmtPrice(o.strike)}</span></div>
              <div><span className="label">Observations</span><span className="v">{o.params.observations}</span></div>
              <div><span className="label">Paid so far / unit</span><span className="v">{o.outcome ? o.outcome.perUnit.toFixed(4) : '—'}</span></div>
            </div>
          </section>

          <section className="card">
            <h3>Schedule (set at pre-trade, observed by Chainlink CRE)</h3>
            <div className="timeline">
              {events.map(e => (
                <div key={e.label} className={`tl ${e.state}`}>
                  <span className="mark" />
                  <span>{e.label}<br /><span className="small muted">{fmtDate(e.when)}</span></span>
                  <span className="num small">{e.value ?? (e.state === 'now' ? 'due' : '')}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="stack">
            <div className="spread"><h3>Workflow</h3><span className="small muted">Highlighted: where this note is now</span></div>
            <BpmnView xml={xml} active={o.activeSteps} />
          </section>
        </div>

        <aside className="stack">
          {o.phase === 'book' && (
            <section className="card">
              <h3>Subscribe</h3>
              <p className="small muted" style={{ margin: 0 }}>Open until {fmtDate(o.strikeDate)}. {fmtMoney(remaining, 0)} units left. One unit = 1 USDC of face.</p>
              <div className="field">
                <label htmlFor="units">Units</label>
                <input id="units" inputMode="decimal" value={units} onChange={e => setUnits(e.target.value)} />
                <span className="hint">You pay {fmtMoney(cost)} USDC, delivered against note units in one transaction.</span>
              </div>
              <button className="btn accent" disabled={!connected || busy || !(Number(units) > 0) || Number(units) > remaining} onClick={subscribe}>
                {connected ? (busy ? 'Subscribing…' : 'Subscribe') : 'Connect a wallet to subscribe'}
              </button>
            </section>
          )}

          {mine && (mine.units > 0 || mine.cash > 0) && (
            <section className="card">
              <h3>Your position</h3>
              <div className="kv" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <div><span className="label">Note units</span><span className="v">{fmtMoney(mine.units)}</span></div>
                <div><span className="label">Cash to withdraw</span><span className="v">{fmtMoney(mine.cash)}</span></div>
              </div>
              <button className="btn" disabled={busy || !(mine.cash > 0)} onClick={withdraw}>Withdraw USDC</button>
            </section>
          )}

          {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.sig && <a href={explorer('tx', msg.sig)} target="_blank" rel="noreferrer">View transaction</a>}</div>}

          <section className="card">
            <h3>Payout per 100 at maturity</h3>
            <PayoffChart params={o.params} />
            <p className="small muted" style={{ margin: 0 }}>Against the final level, % of strike, if not called earlier. Dashed lines: barriers.</p>
          </section>

          <section className="card small">
            <div className="spread"><span className="muted">Issuance</span><a className="num" href={explorer('address', o.address.toBase58())} target="_blank" rel="noreferrer">{o.address.toBase58().slice(0, 8)}…</a></div>
            <div className="spread"><span className="muted">Workflow definition</span><a className="num" href={explorer('address', o.definition.toBase58())} target="_blank" rel="noreferrer">{o.definition.toBase58().slice(0, 8)}…</a></div>
            <div className="spread"><span className="muted">Issuer</span><span className="num">{o.issuer.toBase58().slice(0, 8)}…</span></div>
            <div className="spread"><span className="muted">Price feed</span><span className="num">{o.params.underlying.feed.slice(0, 10)}… ({o.params.underlying.feedChain})</span></div>
          </section>
        </aside>
      </div>
    </div>
  );
}

export { PublicKey };
