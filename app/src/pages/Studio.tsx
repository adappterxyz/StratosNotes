/**
 * Studio: design a note's workflow (Flow's canvas, for StratosNotes).
 *  - Start from any product, or ask the AI ("a phoenix on ETH, 10% p.a. …").
 *  - Edit on the BPMN canvas; the properties panel sets what each step does on
 *    the engine; every change is checked against the validator and compiler.
 *  - Ask the AI to change the open workflow; it answers with a validated patch.
 *  - Publish and issue: unchanged products go to the issue form; edited ones
 *    are published as custom workflows and run from the offering page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import {
  check, compile, EXAMPLE_PRODUCTS, instantiateProduct, irToDraft, OPEN_ROLE, parseBpmn, pda, PRODUCT_LABELS,
  type AssetDefinition, type Issue, type ProductParams, type ProductType,
} from '@stratosnotes/flow';
import PropertiesPanel from '../components/PropertiesPanel';
import { flowModdle } from '../lib/bpmnProps';
import { fitReadable } from '../lib/fit';
import { DEPLOYMENT } from '../config';
import { useEngine } from '../lib/engine';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Chat = { who: 'you' | 'ai'; text: string; notes?: string[] };
const DEFAULT_ASSETS: AssetDefinition[] = [{ id: 'note', name: 'Note', kind: 'issued' }, { id: 'cash', name: 'USDC', kind: 'cash', decimals: 6 }];

export default function Studio() {
  const nav = useNavigate();
  const { engine, connected } = useEngine();
  const { publicKey } = useWallet();
  const host = useRef<HTMLDivElement>(null);
  const modeler = useRef<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [basis, setBasis] = useState<ProductParams | null>(EXAMPLE_PRODUCTS.fcn);
  const [pristineHash, setPristineHash] = useState('');
  const [assets] = useState<AssetDefinition[]>(DEFAULT_ASSETS);
  const [issues, setIssues] = useState<{ errors: Issue[]; warnings: Issue[] }>({ errors: [], warnings: [] });
  const [info, setInfo] = useState({ fields: [] as string[], dates: [] as string[], pools: [] as string[], custom: false, steps: 0 });
  const [chat, setChat] = useState<Chat[]>([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const hashOf = (xml: string) => Array.from(compile(parseBpmn(xml, assets)).hash).map(b => b.toString(16).padStart(2, '0')).join('');

  const recheck = useCallback(async () => {
    const m = modeler.current;
    if (!m) return;
    const { xml } = await m.saveXML({ format: true });
    try {
      const ir = parseBpmn(xml, assets);
      const r = check(ir);
      setIssues(r);
      const fields = [...new Set(ir.nodes.flatMap(n => n.props.templateFields ?? []).map(f => f.name))];
      const dates = [...new Set(ir.nodes.flatMap(n => n.props.templateFields ?? []).filter(f => f.type === 'Date').map(f => f.name))];
      let custom = true;
      try { custom = !r.errors.length ? hashOf(xml) !== pristineHash : true; } catch { /* invalid */ }
      setInfo({ fields, dates, pools: ir.pools.map(p => p.name), custom, steps: ir.nodes.length });
    } catch (e) {
      setIssues({ errors: [{ code: 'PARSE', message: e instanceof Error ? e.message : String(e) }], warnings: [] });
    }
  }, [assets, pristineHash]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!host.current) return;
    const m = new Modeler({ container: host.current, moddleExtensions: { flow: flowModdle } });
    modeler.current = m;
    m.on('selection.changed', (e: any) => setSelected(e.newSelection?.[0] ?? null));
    m.on('commandStack.changed', () => { setVersion(v => v + 1); });
    return () => { if (modeler.current === m) modeler.current = null; m.destroy(); };
  }, []);
  useEffect(() => { const t = setTimeout(recheck, 350); return () => clearTimeout(t); }, [version, recheck]);

  const load = async (xml: string, opts: { pristine?: boolean; highlight?: string[] } = {}) => {
    const m = modeler.current;
    if (!m) return;
    try { await m.importXML(xml); } catch (e) { if (m !== modeler.current) return; throw e; }
    if (m !== modeler.current) return; // replaced while importing (React remount)
    fitReadable(m.get('canvas'));
    if (opts.pristine) setPristineHash(hashOf(xml));
    for (const id of opts.highlight ?? []) { try { (m.get('canvas') as any).addMarker(id, 'active-step'); } catch { /* removed */ } }
    setSelected(null);
    setVersion(v => v + 1);
  };
  const loadProduct = (p: ProductParams) => { setBasis(p); return load(instantiateProduct(p).bpmnXml, { pristine: true }); };
  useEffect(() => { if (modeler.current) loadProduct(EXAMPLE_PRODUCTS.fcn); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async () => {
    const text = prompt.trim();
    if (!text) return;
    setChat(c => [...c, { who: 'you', text }]); setPrompt(''); setBusy('ai'); setError('');
    try {
      const { xml } = await modeler.current.saveXML({ format: true });
      let draft;
      try { draft = irToDraft(parseBpmn(xml, assets)); } catch { draft = undefined; }
      const r = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text, draft }) });
      const j = await r.json() as any;
      if (!r.ok && j.error) throw new Error(j.error);
      if (j.kind === 'product') {
        await loadProduct(j.params);
        setChat(c => [...c, { who: 'ai', text: `Loaded a ${PRODUCT_LABELS[j.params.productType as ProductType].toLowerCase()}: ${j.params.name}. Review it on the canvas, or issue it with the form.`, notes: j.notes }]);
        sessionStorage.setItem('sn-ai-product', JSON.stringify({ params: j.params, schedule: j.schedule }));
      } else if (j.kind === 'workflow') {
        await load(j.bpmnXml, { highlight: j.changed });
        setChat(c => [...c, { who: 'ai', text: `Changed ${j.changed.length} step${j.changed.length === 1 ? '' : 's'} (highlighted). It passes the validator.`, notes: j.warnings }]);
      } else {
        setChat(c => [...c, { who: 'ai', text: j.reply ?? j.error ?? 'No answer.' }]);
      }
    } catch (e) {
      setChat(c => [...c, { who: 'ai', text: e instanceof Error ? e.message : String(e) }]);
    } finally { setBusy(''); }
  };

  /** Publish the open workflow and start an issuance of it (you hold every pool except the subscription book's, which is open). */
  const publishAndIssue = async () => {
    if (!publicKey) return;
    setBusy('publish'); setError('');
    try {
      const { xml } = await modeler.current.saveXML({ format: true });
      const ir = parseBpmn(xml, assets);
      if (!info.custom && basis) {
        sessionStorage.setItem('sn-ai-product', JSON.stringify({ params: basis }));
        nav('/issue');
        return;
      }
      const c = compile(ir, { ...(basis ? { product: basis } : {}), custom: true });
      const definition = await engine.publish(c);
      const openPools = new Set(ir.nodes.filter(n => n.props.until).map(n => n.pool));
      const roles = ir.pools.map(p => (openPools.has(p.id) ? OPEN_ROLE : publicKey));
      const mints = ir.assets.map(a => (a.kind === 'cash' ? new PublicKey(DEPLOYMENT.testUsdc) : PublicKey.default));
      const start = ir.nodes.find(n => n.type === 'startEvent' && !openPools.has(n.pool));
      if (!start) throw new Error('The workflow needs a start event in a pool you hold.');
      const id = BigInt(Date.now());
      const process = pda.process(definition, publicKey, id);
      const ixs = [await engine.startProcess(definition, id, roles, mints, c.stepIndex[start.id])];
      for (const [i, a] of ir.assets.entries()) if (a.kind === 'cash') ixs.push(await engine.openVault(process, i, mints[i]));
      await engine.send(ixs);
      nav(`/note/${process.toBase58()}`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const assetIds = assets.map(a => a.id);
  return (
    <div className="stack" style={{ paddingTop: 24 }}>
      <div className="spread" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 6 }}>
          <span className="label">Studio</span>
          <h1>Design a note's workflow</h1>
        </div>
        <div className="row">
          <label className="small" htmlFor="st-start">Start from</label>
          <select id="st-start" value={basis?.productType ?? ''} onChange={e => loadProduct(EXAMPLE_PRODUCTS[e.target.value as ProductType])}>
            {(Object.keys(PRODUCT_LABELS) as ProductType[]).map(t => <option key={t} value={t}>{PRODUCT_LABELS[t]}</option>)}
          </select>
          <span className={`pill ${info.custom ? 'fixing' : 'book'}`}>{info.custom ? 'Edited: custom workflow' : 'Stock product'}</span>
        </div>
      </div>

      <section className="card stack" style={{ gap: 10 }}>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input aria-label="Ask the AI" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask(); }} style={{ flex: 1, font: '500 14px var(--font)', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--paper)', color: 'var(--ink)' }}
            placeholder='e.g. "Phoenix on ETH, 10% p.a. quarterly, 70% coupon barrier with memory, autocall 100%, KI 60%, 1 year" or "pay a 0.5% fee to the issuer at each coupon"' />
          <button className="btn" onClick={ask} disabled={busy === 'ai' || !prompt.trim()}>{busy === 'ai' ? 'Thinking…' : 'Ask AI'}</button>
        </div>
        {chat.length > 0 && (
          <div className="stack small" style={{ gap: 6, maxHeight: 180, overflowY: 'auto' }}>
            {chat.map((m, i) => (
              <div key={i}><strong>{m.who === 'you' ? 'You' : 'AI'}:</strong> {m.text}{m.notes?.length ? <ul style={{ margin: '4px 0 0', paddingLeft: 18 }} className="muted">{m.notes.map(n => <li key={n}>{n}</li>)}</ul> : null}</div>
            ))}
          </div>
        )}
      </section>

      <div className="two" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 360px)' }}>
        <div className="stack">
          <div ref={host} className="bpmn" style={{ height: 520 }} aria-label="Workflow editor" />
          <span className="small muted">Drag to pan, scroll to zoom. Select an element to edit it; the palette on the left adds steps.</span>
          <section className="card">
            <div className="spread"><h3>Checks</h3><span className="small muted">{info.steps} steps · {issues.errors.length} errors · {issues.warnings.length} warnings</span></div>
            {issues.errors.length === 0 && issues.warnings.length === 0 && <p className="small" style={{ margin: 0, color: 'var(--accent)' }}>The engine accepts this workflow.</p>}
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {issues.errors.map((e, i) => <li key={`e${i}`} style={{ color: 'var(--bad)', cursor: e.nodeId ? 'pointer' : 'default' }} onClick={() => { if (e.nodeId) { const el = modeler.current.get('elementRegistry').get(e.nodeId); if (el) modeler.current.get('selection').select(el); } }}>{e.message}</li>)}
              {issues.warnings.map((w, i) => <li key={`w${i}`} style={{ color: 'var(--warn)' }}>{w.message}</li>)}
            </ul>
          </section>
        </div>
        <aside className="stack">
          <PropertiesPanel modeler={modeler.current} element={selected} fieldNames={info.fields} dateFields={info.dates} pools={info.pools} assets={assetIds} version={version} />
          <section className="card">
            <h3>Publish and issue</h3>
            <p className="small muted" style={{ margin: 0 }}>{info.custom
              ? 'Publishes this workflow on Solana and starts an issuance: you hold every pool except the subscription book, which is open to anyone. You then complete its steps (terms, reserve) from the note page.'
              : 'Unchanged product: issue it with the term-sheet form (size, dates, reserve).'}</p>
            <button className="btn accent" disabled={!connected || !!busy || issues.errors.length > 0} onClick={publishAndIssue}>
              {!connected ? 'Connect a wallet' : busy === 'publish' ? 'Publishing…' : info.custom ? 'Publish and start issuance' : 'Continue to the issue form'}
            </button>
            {error && <div className="notice err" role="alert">{error}</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}
