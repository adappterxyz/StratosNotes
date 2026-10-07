/**
 * Issue: Flow's workspace, for structured notes. With nothing open it is a
 * start page (a template, a term sheet, the AI, or a blank workflow); with a
 * workflow open it is the AI assistant, the BPMN canvas and the stages in
 * order: Overview | Properties -> Validate -> Payoff -> Template -> Issue.
 * Templates and edited workflows are issued from the same place.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import Modeler from 'bpmn-js/lib/Modeler';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import {
  ArrowRight, BookOpen, LayoutTemplate, CheckCircle2, AlertCircle, ChevronRight, Download, FilePlus2, FileUp, LayoutList, LineChart, Rocket, Sparkles, TrendingUp, Workflow, X,
} from 'lucide-react';
import {
  buildWorkflow, chain, check, compileTemplate, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, field, instantiateProduct, irToDraft, normalizeParams, parseBpmn,
  PRODUCT_LABELS, summarize, templateBpmn, underlyingLabel,
  type AssetDefinition, type Issue, type ProductParams, type ProductType, type TemplateEntry, type TemplateSummary,
} from '@stratosnotes/flow';
import AiPanel, { type AiResult } from '../components/AiPanel';
import ProductDialog from '../components/ProductDialog';
import PropertiesPanel from '../components/PropertiesPanel';
import { IssuePanel, OverviewPanel, PayoffPanel, TemplatePanel, ValidatePanel, type Built, type DocInfo, type Stage } from '../components/Stages';
import { flowModdle } from '../lib/bpmnProps';
import { fitReadable } from '../lib/fit';
import { tagTypes } from '../lib/bpmnTheme';
import { headline, short } from '../lib/offerings';

/* eslint-disable @typescript-eslint/no-explicit-any */
const NOTE_ASSETS: AssetDefinition[] = [{ id: 'note', name: 'Note', kind: 'issued' }, { id: 'cash', name: 'USDC', kind: 'cash', decimals: 6 }];
const STOCK: ProductParams[] = [...(Object.keys(EXAMPLE_PRODUCTS) as ProductType[]).map(t => EXAMPLE_PRODUCTS[t]), EXAMPLE_WORST_OF];

/** A blank note: an Issuer pool with a pre-trade step, to build on. */
function blankWorkflow() {
  return buildWorkflow({
    key: 'BL', name: 'Untitled note',
    pools: [{
      id: 'Part_Issuer', name: 'Issuer', proc: 'Proc_Issuer',
      nodes: [
        { id: 'Start_Issuer', type: 'startEvent', name: 'Offer Drafted', col: 0 },
        { id: 'Task_ApproveTerms', type: 'userTask', name: 'Approve Terms', col: 1, props: { templateFields: [field('isin', 'Text'), field('notional', 'Decimal')] } },
        { id: 'End_Issuer', type: 'endEvent', name: 'Done', col: 2 },
      ],
      flows: chain('I_F', 'Start_Issuer', 'Task_ApproveTerms', 'End_Issuer'),
    }],
    messages: [], assets: NOTE_ASSETS,
  });
}

interface Doc extends DocInfo { assets: AssetDefinition[]; pristine: string }

export default function Workspace() {
  const [search, setSearch] = useSearchParams();
  const host = useRef<HTMLDivElement>(null);
  const modeler = useRef<any>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [stage, setStage] = useState<Stage>('design');
  const [aiOpen, setAiOpen] = useState(false);
  const [productDialog, setProductDialog] = useState<{ initial: ProductParams | null; hint?: DocInfo['hint'] } | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [version, setVersion] = useState(0);
  const [issues, setIssues] = useState<{ errors: Issue[]; warnings: Issue[] }>({ errors: [], warnings: [] });
  const [info, setInfo] = useState({ fields: [] as string[], dates: [] as string[], pools: [] as string[], steps: 0 });
  const [built, setBuilt] = useState<Built | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [notice, setNotice] = useState('');

  // ---- canvas ---------------------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    const m = new Modeler({ container: host.current, moddleExtensions: { flow: flowModdle } });
    modeler.current = m;
    m.on('selection.changed', (e: any) => setSelected(e.newSelection?.[0] ?? null));
    m.on('commandStack.changed', () => { tagTypes(m); setVersion(v => v + 1); });
    return () => { if (modeler.current === m) modeler.current = null; m.destroy(); };
  }, []);

  const xmlNow = async () => (await modeler.current.saveXML({ format: true })).xml as string;
  const fingerprint = (xml: string, assets: AssetDefinition[]) => Array.from(compileTemplate({ bpmnXml: xml, assets }).hash).map(b => b.toString(16).padStart(2, '0')).join('');

  const load = async (xml: string, next: Omit<Doc, 'pristine' | 'edited'>, opts: { highlight?: string[]; keepPristine?: string } = {}) => {
    const m = modeler.current;
    if (!m) return;
    await m.importXML(xml);
    if (m !== modeler.current) return;
    tagTypes(m);
    fitReadable(m.get('canvas'));
    for (const id of opts.highlight ?? []) { try { m.get('canvas').addMarker(id, 'active-step'); } catch { /* removed */ } }
    let pristine = opts.keepPristine ?? '';
    if (!opts.keepPristine) { try { pristine = fingerprint(await xmlNow(), next.assets); } catch { /* invalid: never pristine */ } }
    setDoc({ ...next, pristine, edited: false });
    setSelected(null);
    setVersion(v => v + 1);
  };

  const openProduct = async (p: ProductParams, extra: Partial<Doc> = {}) => {
    const prod = instantiateProduct(p);
    await load(prod.bpmnXml, { name: p.name, origin: 'product', basis: p, assets: prod.assets, ...extra });
    setStage('design');
  };
  const openTemplate = async (t: TemplateSummary) => {
    setNotice('');
    try {
      const r = await fetch(`/api/templates/${t.definition}`);
      if (!r.ok) throw new Error(`Template ${short(t.definition)} could not be read (${r.status}).`);
      const e = await r.json() as TemplateEntry;
      const { bpmnXml, assets } = templateBpmn(e);
      const basis = e.product ? normalizeParams(e.product) : e.basis ? normalizeParams(e.basis) : null;
      await load(bpmnXml, { name: e.name, origin: e.product && !e.bpmnXml ? 'product' : 'custom', basis, assets, template: summarize(e) });
      setStage('issue');
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
  };
  const openBlank = async () => {
    const b = blankWorkflow();
    await load(b.bpmnXml, { name: 'Untitled note', origin: 'custom', basis: null, assets: b.assets });
    setStage('design');
  };
  const close = () => { setDoc(null); setBuilt(null); setSelected(null); setSearch({}, { replace: true }); };
  /** Back to the start page, at the template list (the open workflow is closed). */
  const showTemplates = () => { close(); setTimeout(() => document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' }), 50); };

  // Deep links: /issue?template=<definition> or /issue?product=<type>.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !modeler.current) return;
    linked.current = true;
    const t = search.get('template');
    const p = search.get('product') as ProductType | 'worst-of' | null;
    if (t) openTemplate({ definition: t, name: '', description: '', author: '', createdAt: 0, kind: 'custom', label: '' }).then(() => {});
    else if (p === 'worst-of') openProduct(EXAMPLE_WORST_OF);
    else if (p && EXAMPLE_PRODUCTS[p]) openProduct(EXAMPLE_PRODUCTS[p]);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch('/api/templates').then(r => (r.ok ? r.json() : [])).then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // ---- checks: on every change, validate and compile as it would be published ----
  const recheck = useCallback(async () => {
    if (!modeler.current || !doc) return;
    const xml = await xmlNow();
    try {
      const ir = parseBpmn(xml, doc.assets);
      const r = check(ir);
      setIssues(r);
      const tf = ir.nodes.flatMap(n => n.props.templateFields ?? []);
      setInfo({ fields: [...new Set(tf.map(f => f.name))], dates: [...new Set(tf.filter(f => f.type === 'Date').map(f => f.name))], pools: ir.pools.map(p => p.name), steps: ir.nodes.length });
      let edited = true;
      try { edited = fingerprint(xml, doc.assets) !== doc.pristine; } catch { /* does not compile */ }
      if (edited !== doc.edited) setDoc(d => (d ? { ...d, edited } : d));
      const source = doc.origin === 'product' && !edited && doc.basis ? { product: doc.basis } : { bpmnXml: xml, assets: doc.assets, ...(doc.basis ? { basis: doc.basis } : {}) };
      if (r.errors.length) { setBuilt(null); return; }
      try { setBuilt({ ir, c: compileTemplate(source), source }); }
      catch (e) { setBuilt(null); setIssues({ errors: [...r.errors, { code: 'COMPILE', message: e instanceof Error ? e.message : String(e) }], warnings: r.warnings }); }
    } catch (e) {
      setIssues({ errors: [{ code: 'PARSE', message: e instanceof Error ? e.message : String(e) }], warnings: [] });
      setBuilt(null);
    }
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(recheck, 300); return () => clearTimeout(t); }, [version, recheck]);

  const build = async (): Promise<Built> => {
    if (!built) throw new Error('Fix the errors in Validate first.');
    return built;
  };

  // ---- AI ---------------------------------------------------------------------
  const draft = async () => { if (!doc) return undefined; try { return irToDraft(parseBpmn(await xmlNow(), doc.assets)); } catch { return undefined; } };
  const onAi = async (r: AiResult): Promise<string> => {
    if (r.kind === 'product') {
      setProductDialog({ initial: r.params, hint: r.schedule ? { size: r.schedule.size, every: r.schedule.every, unit: r.schedule.unit } : undefined });
      return `Read it as a ${PRODUCT_LABELS[r.params.productType].toLowerCase()} on ${underlyingLabel(r.params)}. Review the terms in the dialog, then open the workflow.`;
    }
    if (r.kind === 'workflow') {
      const base: Doc = doc ?? { name: 'AI workflow', origin: 'custom', basis: null, assets: NOTE_ASSETS, pristine: '', edited: true };
      await load(r.bpmnXml, { name: base.name, origin: base.origin, basis: base.basis, assets: base.assets, template: base.template, hint: base.hint }, { highlight: r.changed, keepPristine: base.pristine || 'none' });
      setStage('design');
      return `Changed ${r.changed.length} step${r.changed.length === 1 ? '' : 's'} (highlighted on the canvas). It passes the validator.`;
    }
    return r.reply ?? r.error ?? 'No answer.';
  };

  // ---- import / export ---------------------------------------------------------
  const importFile = async (f: File) => {
    const xml = await f.text();
    try { parseBpmn(xml, NOTE_ASSETS); } catch (e) { setNotice(`Could not read ${f.name}: ${e instanceof Error ? e.message : String(e)}`); return; }
    await load(xml, { name: f.name.replace(/\.(bpmn|xml)$/i, ''), origin: 'custom', basis: null, assets: NOTE_ASSETS });
    setStage('validate');
  };
  const exportFile = async () => {
    const url = URL.createObjectURL(new Blob([await xmlNow()], { type: 'application/xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${(doc?.name || 'note').replace(/[^\w.-]+/g, '_')}.bpmn`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectNode = (id: string) => { const el = modeler.current?.get('elementRegistry').get(id); if (el) { modeler.current.get('selection').select(el); setStage('design'); } };

  const stages: Array<{ id: Stage; label: string; icon: ReactNode }> = [
    { id: 'design', label: selected ? 'Properties' : 'Overview', icon: selected ? <Workflow className="i" /> : <LayoutList className="i" /> },
    { id: 'validate', label: issues.errors.length ? `Validate (${issues.errors.length})` : 'Validate', icon: issues.errors.length ? <AlertCircle className="i" style={{ color: 'hsl(var(--destructive))' }} /> : <CheckCircle2 className="i" /> },
    { id: 'payoff', label: 'Payoff', icon: <LineChart className="i" /> },
    { id: 'template', label: 'Template', icon: <BookOpen className="i" /> },
    { id: 'issue', label: 'Issue', icon: <Rocket className="i" /> },
  ];

  return (
    <div className="ws">
      {aiOpen && <AiPanel draft={draft} onResult={onAi} onClose={() => setAiOpen(false)} />}
      <div className="ws-main">
        <div className="ws-bar">
          <input ref={fileInput} type="file" accept=".bpmn,.xml" hidden onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
          {doc && <button className="btn" onClick={close} title="Close this workflow"><X className="i" />Close</button>}
          <button className="btn" onClick={showTemplates} title="Products and published templates"><LayoutTemplate className="i" />Templates</button>
          <button className="btn" onClick={() => fileInput.current?.click()}><FileUp className="i" />Import</button>
          {doc && <button className="btn" onClick={exportFile}><Download className="i" />Export BPMN</button>}
          {doc && <span className="row" style={{ gap: 4 }}><ChevronRight className="i dim" /><span className="name" title={doc.name}>{doc.name}</span></span>}
          <button className={`btn ${aiOpen ? 'on' : ''}`} onClick={() => setAiOpen(o => !o)}><Sparkles className="i" />AI</button>
          {doc && (
            <nav className="seg" aria-label="Stages" style={{ marginLeft: 'auto' }}>
              {stages.map((s, i) => (
                <span key={s.id} className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                  {i > 0 && <span className="arrow" aria-hidden="true">›</span>}
                  <button className={stage === s.id ? 'active' : ''} aria-current={stage === s.id ? 'step' : undefined} onClick={() => setStage(s.id)}>{s.icon}{s.label}</button>
                </span>
              ))}
            </nav>
          )}
        </div>
        <div className="ws-body">
          <div className={`ws-canvas ${doc ? '' : 'empty'}`}>
            <div ref={host} className="bpmn" aria-label="Workflow editor" />
            {!doc && (
              <div className="ws-start">
                <div className="ws-start-inner">
                  <div>
                    <h1>Issue a note</h1>
                    <p className="small muted" style={{ marginTop: 6, maxWidth: '64ch' }}>Start from a template and issue it as it is, or design one in the studio: change the term sheet, edit the workflow on the canvas or ask the AI, then issue it or save it as a template for others.</p>
                  </div>
                  <div className="start-cards">
                    {[
                      { icon: <Workflow className="i" />, title: 'From a template', detail: 'Stock payoffs and templates other issuers published. Pick one below.', onClick: () => document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' }), primary: true },
                      { icon: <TrendingUp className="i" />, title: 'Structured product', detail: 'FCN, reverse convertible, phoenix, snowball or principal-protected, on one underlying or a worst-of basket.', onClick: () => setProductDialog({ initial: null }) },
                      { icon: <Sparkles className="i" />, title: 'Describe it to the AI', detail: 'Paste a term sheet or describe the note; missing terms come back as a question.', onClick: () => setAiOpen(true) },
                      { icon: <FilePlus2 className="i" />, title: 'Blank workflow', detail: 'An Issuer pool with a pre-trade step: draw the rest on the canvas.', onClick: openBlank },
                    ].map(c => (
                      <button key={c.title} className={`start-card ${c.primary ? 'primary' : ''}`} onClick={c.onClick}>
                        <span className="t">{c.icon}{c.title}</span>
                        <span className="d">{c.detail}</span>
                      </button>
                    ))}
                  </div>
                  {notice && <div className="notice err" role="alert">{notice}</div>}
                  <section id="templates" className="stack" style={{ gap: 10 }}>
                    <div className="spread"><h2>Products</h2><span className="xs muted">Verified payoff engines; issue as is or edit first</span></div>
                    <div className="tpl-grid">
                      {STOCK.map(p => (
                        <button key={p.name} className="tpl" onClick={() => openProduct(p)}>
                          <span className="label">{PRODUCT_LABELS[p.productType]} · {underlyingLabel(p)}</span>
                          <span className="n">{p.name}</span>
                          <span className="xs muted">{headline(p)}</span>
                          <span className="xs row" style={{ color: 'hsl(var(--primary))', gap: 4 }}>Open <ArrowRight className="i" style={{ width: 12, height: 12 }} /></span>
                        </button>
                      ))}
                    </div>
                    <div className="spread" style={{ marginTop: 8 }}><h2>Published templates</h2><span className="xs muted">Saved by issuers from the studio</span></div>
                    {templates === null ? <p className="xs muted">Loading the template library…</p>
                      : templates.length === 0 ? <div className="empty small">No templates yet. Open a product or design a workflow, then save it from the Template stage.</div>
                      : (
                        <div className="tpl-grid">
                          {templates.map(t => (
                            <button key={t.definition} className="tpl" onClick={() => openTemplate(t)}>
                              <span className="label">{t.label}</span>
                              <span className="n">{t.name}</span>
                              {t.description && <span className="xs muted">{t.description}</span>}
                              <span className="xs dim">by {short(t.author)} · {new Date(t.createdAt * 1000).toLocaleDateString()}</span>
                            </button>
                          ))}
                        </div>
                      )}
                  </section>
                </div>
              </div>
            )}
          </div>
          {doc && (
            <aside className="ws-panel" aria-label="Stage">
              {stage === 'design' && (selected
                ? <div className="section"><PropertiesPanel modeler={modeler.current} element={selected} fieldNames={info.fields} dateFields={info.dates} pools={info.pools} assets={doc.assets.map(a => a.id)} version={version} /></div>
                : <OverviewPanel doc={doc} info={{ ...info, errors: issues.errors.length, warnings: issues.warnings.length }} onStage={setStage}
                    onEditTerms={() => setProductDialog({ initial: doc.basis })} />)}
              {stage === 'validate' && <ValidatePanel issues={issues} onSelect={selectNode} />}
              {stage === 'payoff' && <PayoffPanel key={doc.pristine + String(doc.edited)} doc={doc} />}
              {stage === 'template' && <TemplatePanel key={doc.pristine} doc={doc} build={build} onSaved={t => { setDoc(d => (d ? { ...d, template: t } : d)); setTemplates(x => [t, ...(x ?? []).filter(y => y.definition !== t.definition)]); }} />}
              {stage === 'issue' && <IssuePanel key={doc.pristine} doc={doc} built={built} />}
            </aside>
          )}
        </div>
      </div>
      {productDialog && (
        <ProductDialog initial={productDialog.initial} onClose={() => setProductDialog(null)}
          onCreate={p => { const hint = productDialog.hint; setProductDialog(null); openProduct(p, hint ? { hint } : {}); }} />
      )}
    </div>
  );
}
