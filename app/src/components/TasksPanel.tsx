/**
 * Steps waiting for the connected wallet: any user task whose pool is held by
 * this wallet (or is open to anyone), and unconditioned decisions it makes.
 * The form is built from the step's input fields; a step that takes a cash
 * deposit sends the wallet's USDC with it. Works for every workflow, stock or
 * custom.
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { dec, FKIND, KIND, OP, OPEN_ROLE, SRC, slot, type Slot } from '@stratosnotes/flow';
import { explorer } from '../config';
import { useEngine } from '../lib/engine';
import type { Offering } from '../lib/offerings';

const KIND_NAME: Record<number, string> = Object.fromEntries(Object.entries(FKIND).map(([k, v]) => [v, k]));

export default function TasksPanel({ o, onDone, hide = [] }: { o: Offering; onDone: () => void; hide?: string[] }) {
  const { publicKey } = useWallet();
  const { engine } = useEngine();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; sig?: string } | null>(null);
  if (!publicKey || o.process.status !== 0) return null;
  let names: Record<string, string> = {};
  try { names = JSON.parse(o.def.meta).names ?? {}; } catch { /* ids */ }

  const mine = [...new Set(o.process.tokens)]
    .map(i => ({ i, s: o.def.steps[i] }))
    .filter(({ s }) => s && !hide.includes(s.id))
    .filter(({ s }) => {
      const holder = o.process.roles[s.role];
      const myRole = holder.equals(publicKey) || holder.equals(OPEN_ROLE);
      const decision = s.kind === KIND.XOR && s.next.every(e => e.cond === 0xffff) && s.next.length > 1;
      return myRole && (s.kind === KIND.USER || decision);
    });
  if (!mine.length) return null;

  const run = async (i: number, choice?: number) => {
    const s = o.def.steps[i];
    setBusy(s.id); setMsg(null);
    try {
      const inputs: Slot[] = s.captures.filter(c => c.source === SRC.INPUT).map(c => {
        const f = o.def.fields[c.field];
        const raw = (values[`${s.id}.${f.name}`] ?? '').trim();
        if (!raw) throw new Error(`Enter ${f.name}.`);
        if (f.kind === FKIND.Text) return slot.text(raw);
        if (f.kind === FKIND.Party) return slot.key(new PublicKey(raw));
        if (f.kind === FKIND.Date) return slot.number(BigInt(Math.floor(new Date(raw).getTime() / 1000)));
        if (f.kind === FKIND.Bool) return slot.number(raw === 'true' ? 1n : 0n);
        if (f.kind === FKIND.Int) return slot.number(BigInt(raw));
        return slot.number(dec(raw));
      });
      const dep = s.ops.find(op => op.kind === OP.DEPOSIT);
      const ixs = [];
      if (dep) ixs.push(await engine.openVault(o.address, dep.asset, o.process.mints[dep.asset]));
      ixs.push(await engine.executeStep(o.address, o.definition, i, inputs, { ...(choice !== undefined ? { choice } : {}), ...(dep ? { deposit: { asset: dep.asset, mint: o.process.mints[dep.asset] } } : {}) }));
      const sig = await engine.send(ixs);
      setMsg({ kind: 'ok', text: `${names[s.id] ?? s.id}: done.`, sig });
      onDone();
    } catch (e) { setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(''); }
  };

  return (
    <section className="card">
      <h3>Waiting for you</h3>
      {mine.map(({ i, s }) => {
        const ins = s.captures.filter(c => c.source === SRC.INPUT).map(c => o.def.fields[c.field]);
        const decision = s.kind === KIND.XOR;
        const dep = s.ops.some(op => op.kind === OP.DEPOSIT);
        return (
          <div key={s.id} className="stack" style={{ gap: 8, borderTop: '1px solid hsl(var(--border))', paddingTop: 10 }}>
            <div className="spread"><strong>{names[s.id] ?? s.id}</strong><span className="xs muted">{o.def.roles[s.role]}{s.until ? ' · repeatable' : ''}</span></div>
            {ins.map(f => (
              <div key={f.name} className="field">
                <label htmlFor={`t-${s.id}-${f.name}`}>{f.name} <span className="muted">({KIND_NAME[f.kind]})</span></label>
                <input id={`t-${s.id}-${f.name}`} type={f.kind === FKIND.Date ? 'datetime-local' : 'text'} value={values[`${s.id}.${f.name}`] ?? ''} onChange={e => setValues(v => ({ ...v, [`${s.id}.${f.name}`]: e.target.value }))} />
              </div>
            ))}
            {dep && <span className="small muted">This step takes a USDC deposit from your wallet.</span>}
            {decision
              ? <div className="row">{s.next.map((e, k) => <button key={k} className="btn" disabled={!!busy} onClick={() => run(i, k)}>{names[o.def.steps[e.target].id] ?? o.def.steps[e.target].id}</button>)}</div>
              : <button className="btn primary" disabled={!!busy} onClick={() => run(i)}>{busy === s.id ? 'Sending…' : 'Complete'}</button>}
          </div>
        );
      })}
      {msg && <div className={`notice ${msg.kind}`} role="status">{msg.text} {msg.sig && <a href={explorer('tx', msg.sig)} target="_blank" rel="noreferrer">View transaction</a>}</div>}
    </section>
  );
}
