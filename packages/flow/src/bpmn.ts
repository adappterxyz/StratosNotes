/**
 * BPMN 2.0 collaboration XML <-> workflow IR.
 *
 * Step properties live in each element's extensionElements as
 * <flow:Properties templateFields="[json]" assetOperation="{json}" timer="{json}"
 * receiveGuard="..."/>. Flow's <canton:Properties> is read the same way, so
 * diagrams exported from Flow import unchanged.
 */
import { DOMParser } from '@xmldom/xmldom';
import type { AssetDefinition, IrFlow, IrNode, IrPool, NodeProps, NodeType, PropsMap, TemplateField, WorkflowIR } from './types';

export const FLOW_NS = 'https://stratosnotes.dev/bpmn';

const NODE_TYPES: NodeType[] = ['startEvent', 'endEvent', 'userTask', 'serviceTask', 'task', 'receiveTask', 'sendTask', 'exclusiveGateway', 'parallelGateway', 'intermediateCatchEvent'];

type El = { localName: string; getAttribute(n: string): string | null; childNodes: ArrayLike<any>; textContent: string | null };

const local = (e: El) => e.localName || '';
const kids = (e: El, name?: string): El[] => {
  const out: El[] = [];
  for (let i = 0; i < e.childNodes.length; i++) {
    const c = e.childNodes[i];
    if (c.nodeType === 1 && (!name || local(c) === name)) out.push(c);
  }
  return out;
};

function readProps(el: El): NodeProps {
  const props: NodeProps = {};
  const ext = kids(el, 'extensionElements')[0];
  const p = ext && kids(ext).find(c => local(c) === 'Properties' || local(c) === 'properties');
  if (p) {
    const json = <T,>(name: string): T | undefined => {
      const v = p.getAttribute(name);
      if (!v) return undefined;
      try { return JSON.parse(v) as T; } catch { throw new Error(`${el.getAttribute('id')}: ${name} is not valid JSON`); }
    };
    const tf = json<TemplateField[]>('templateFields');
    if (tf?.length) props.templateFields = tf;
    const ao = json<NodeProps['assetOperation']>('assetOperation');
    if (ao) props.assetOperation = ao;
    const aos = json<NodeProps['assetOperations']>('assetOperations');
    if (aos?.length) props.assetOperations = aos;
    const until = json<NodeProps['until']>('until');
    if (until) props.until = until;
    const timer = json<NodeProps['timer']>('timer');
    if (timer) props.timer = timer;
    const guard = p.getAttribute('receiveGuard');
    if (guard) props.receiveGuard = guard;
    const ctrl = p.getAttribute('controllers');
    if (ctrl) props.controllers = ctrl.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Standard BPMN timer (any tool): <timerEventDefinition><timeDate>.
  const td = kids(el, 'timerEventDefinition')[0];
  const date = td && kids(td, 'timeDate')[0]?.textContent?.trim();
  if (date && !props.timer) props.timer = { date };
  return props;
}

export function parseBpmn(xml: string, assets: AssetDefinition[] = []): WorkflowIR {
  const doc = new DOMParser().parseFromString(xml.replace(/<\?xml[^?]*\?>\s*/g, ''), 'text/xml');
  const root = doc.documentElement as unknown as El;
  if (!root || local(root) !== 'definitions') throw new Error('Not a BPMN document (no definitions root)');
  const collab = kids(root, 'collaboration')[0];
  const processes = kids(root, 'process');
  if (!processes.length) throw new Error('No process in the BPMN document');

  const procToPool = new Map<string, IrPool>();
  const pools: IrPool[] = [];
  for (const part of collab ? kids(collab, 'participant') : []) {
    const pool = { id: part.getAttribute('id') || '', name: part.getAttribute('name') || part.getAttribute('id') || '' };
    pools.push(pool);
    const ref = part.getAttribute('processRef');
    if (ref) procToPool.set(ref, pool);
  }
  if (!pools.length) {
    const only = { id: 'Pool_1', name: processes[0].getAttribute('name') || 'Initiator' };
    pools.push(only);
    procToPool.set(processes[0].getAttribute('id') || '', only);
  }

  const nodes: IrNode[] = [];
  const flows: IrFlow[] = [];
  for (const proc of processes) {
    const pool = procToPool.get(proc.getAttribute('id') || '') ?? pools[0];
    for (const el of kids(proc)) {
      const t = local(el) as NodeType;
      if (NODE_TYPES.includes(t)) {
        const id = el.getAttribute('id') || '';
        nodes.push({ id, type: t, name: el.getAttribute('name') || id, pool: pool.id, props: readProps(el), incoming: [], outgoing: [], ...(el.getAttribute('default') ? { defaultFlow: el.getAttribute('default')! } : {}) });
      } else if (local(el) === 'sequenceFlow') {
        const cond = kids(el, 'conditionExpression')[0]?.textContent?.trim();
        flows.push({ id: el.getAttribute('id') || '', source: el.getAttribute('sourceRef') || '', target: el.getAttribute('targetRef') || '', ...(el.getAttribute('name') ? { name: el.getAttribute('name')! } : {}), ...(cond ? { condition: cond } : {}) });
      }
    }
  }
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const f of flows) {
    byId.get(f.source)?.outgoing.push(f.id);
    byId.get(f.target)?.incoming.push(f.id);
  }
  const messageFlows = (collab ? kids(collab, 'messageFlow') : []).map(m => ({ id: m.getAttribute('id') || '', source: m.getAttribute('sourceRef') || '', target: m.getAttribute('targetRef') || '' }));
  const defs = root.getAttribute('id') || 'Workflow';
  return { name: collab?.getAttribute('name') || defs.replace(/^Definitions_/, ''), pools, nodes, flows, messageFlows, assets };
}

// ---------------------------------------------------------------------------
// Deterministic builder (Flow's products/bpmn-builder.ts): a compact pool/grid
// spec in, laid-out BPMN XML with the step properties embedded out.

export interface SpecNode {
  id: string;
  type: 'startEvent' | 'endEvent' | 'userTask' | 'serviceTask' | 'receiveTask' | 'exclusiveGateway' | 'parallelGateway';
  name: string;
  col: number;
  row?: number;
  props?: NodeProps;
}
export interface SpecFlow { id: string; src: string; tgt: string; name?: string; cond?: string; isDefault?: boolean }
export interface SpecPool { id: string; name: string; proc: string; nodes: SpecNode[]; flows: SpecFlow[] }
export interface BuildSpec { key: string; name: string; pools: SpecPool[]; messages: Array<{ id: string; src: string; tgt: string }>; assets: AssetDefinition[] }
export interface BuiltWorkflow { bpmnXml: string; props: PropsMap; assets: AssetDefinition[] }

const COL_W = 185, ROW_H = 125, X0 = 220, POOL_GAP = 20;
const SIZE: Record<string, [number, number]> = { task: [150, 80], event: [36, 36], gateway: [44, 44] };
const kindOf = (t: string) => (t === 'startEvent' || t === 'endEvent') ? 'event' : t.endsWith('Gateway') ? 'gateway' : 'task';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const field = (name: string, type: TemplateField['type'], extra: Partial<TemplateField> = {}): TemplateField => ({ name, type, ...extra });
export const chain = (prefix: string, ...ids: string[]): SpecFlow[] => ids.slice(1).map((tgt, i) => ({ id: `${prefix}${i + 1}`, src: ids[i], tgt }));

function propsXml(p: NodeProps | undefined): string {
  if (!p) return '';
  const attrs: string[] = [];
  if (p.templateFields?.length) attrs.push(`templateFields="${esc(JSON.stringify(p.templateFields))}"`);
  if (p.assetOperation) attrs.push(`assetOperation="${esc(JSON.stringify(p.assetOperation))}"`);
  if (p.assetOperations?.length) attrs.push(`assetOperations="${esc(JSON.stringify(p.assetOperations))}"`);
  if (p.until) attrs.push(`until="${esc(JSON.stringify(p.until))}"`);
  if (p.timer) attrs.push(`timer="${esc(JSON.stringify(p.timer))}"`);
  if (p.receiveGuard) attrs.push(`receiveGuard="${esc(p.receiveGuard)}"`);
  return attrs.length ? `<bpmn:extensionElements><flow:Properties ${attrs.join(' ')} /></bpmn:extensionElements>` : '';
}

export function buildWorkflow(spec: BuildSpec): BuiltWorkflow {
  const geo = new Map<string, { cx: number; cy: number; w: number; h: number; type: string }>();
  const shapes: string[] = [], edges: string[] = [], procs: string[] = [];
  const maxCol = Math.max(...spec.pools.flatMap(p => p.nodes.map(n => n.col)));
  const width = X0 + maxCol * COL_W + 50;
  let y = 80;
  for (const p of spec.pools) {
    const rows = Math.max(...p.nodes.map(n => n.row ?? 0)) + 1;
    const h = rows * ROW_H + 30;
    shapes.push(`      <bpmndi:BPMNShape id="${p.id}_di" bpmnElement="${p.id}" isHorizontal="true"><dc:Bounds x="140" y="${y}" width="${width}" height="${h}" /></bpmndi:BPMNShape>`);
    for (const n of p.nodes) {
      const [w, hh] = SIZE[kindOf(n.type)];
      const cx = X0 + n.col * COL_W + 75;
      const cy = y + 15 + Math.floor(ROW_H / 2) + (n.row ?? 0) * ROW_H;
      geo.set(n.id, { cx, cy, w, h: hh, type: n.type });
      const marker = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : '';
      shapes.push(`      <bpmndi:BPMNShape id="${n.id}_di" bpmnElement="${n.id}"${marker}><dc:Bounds x="${cx - Math.floor(w / 2)}" y="${cy - Math.floor(hh / 2)}" width="${w}" height="${hh}" /></bpmndi:BPMNShape>`);
    }
    y += h + POOL_GAP;
  }
  const pts = (ps: Array<[number, number]>) => ps.map(([a, b]) => `<di:waypoint x="${a}" y="${b}" />`).join('');
  for (const p of spec.pools) {
    const lines = [`  <bpmn:process id="${p.proc}" isExecutable="true">`];
    const defaults = new Map(p.flows.filter(f => f.isDefault).map(f => [f.src, f.id]));
    for (const n of p.nodes) {
      const d = defaults.has(n.id) ? ` default="${defaults.get(n.id)}"` : '';
      const inner = propsXml(n.props);
      lines.push(inner ? `    <bpmn:${n.type} id="${n.id}" name="${esc(n.name)}"${d}>${inner}</bpmn:${n.type}>` : `    <bpmn:${n.type} id="${n.id}" name="${esc(n.name)}"${d} />`);
    }
    for (const f of p.flows) {
      const nm = f.name ? ` name="${esc(f.name)}"` : '';
      lines.push(f.cond
        ? `    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.src}" targetRef="${f.tgt}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${esc(f.cond)}</bpmn:conditionExpression></bpmn:sequenceFlow>`
        : `    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.src}" targetRef="${f.tgt}" />`);
      const s = geo.get(f.src)!, t = geo.get(f.tgt)!;
      let way: Array<[number, number]>;
      if (s.cy === t.cy) way = [[s.cx + s.w / 2, s.cy], [t.cx - t.w / 2, t.cy]];
      else if (kindOf(s.type) === 'gateway') way = [[s.cx, t.cy > s.cy ? s.cy + s.h / 2 : s.cy - s.h / 2], [s.cx, t.cy], [t.cx - t.w / 2, t.cy]];
      else { const mx = Math.floor((s.cx + s.w / 2 + t.cx - t.w / 2) / 2); way = [[s.cx + s.w / 2, s.cy], [mx, s.cy], [mx, t.cy], [t.cx - t.w / 2, t.cy]]; }
      edges.push(`      <bpmndi:BPMNEdge id="${f.id}_di" bpmnElement="${f.id}">${pts(way)}</bpmndi:BPMNEdge>`);
    }
    lines.push('  </bpmn:process>');
    procs.push(lines.join('\n'));
  }
  for (const m of spec.messages) {
    const s = geo.get(m.src)!, t = geo.get(m.tgt)!;
    const mid = Math.floor((s.cy + t.cy) / 2);
    const way: Array<[number, number]> = t.cy > s.cy
      ? [[s.cx, s.cy + s.h / 2], [s.cx, mid], [t.cx, mid], [t.cx, t.cy - t.h / 2]]
      : [[s.cx, s.cy - s.h / 2], [s.cx, mid], [t.cx, mid], [t.cx, t.cy + t.h / 2]];
    edges.push(`      <bpmndi:BPMNEdge id="${m.id}_di" bpmnElement="${m.id}">${pts(way)}</bpmndi:BPMNEdge>`);
  }
  const k = spec.key;
  const bpmnXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flow="${FLOW_NS}"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                  id="Definitions_${k}" targetNamespace="${FLOW_NS}">
  <bpmn:collaboration id="Collab_${k}" name="${esc(spec.name)}">
${spec.pools.map(p => `    <bpmn:participant id="${p.id}" name="${esc(p.name)}" processRef="${p.proc}" />`).join('\n')}
${spec.messages.map(m => `    <bpmn:messageFlow id="${m.id}" sourceRef="${m.src}" targetRef="${m.tgt}" />`).join('\n')}
  </bpmn:collaboration>
${procs.join('\n')}
  <bpmndi:BPMNDiagram id="BPMNDiagram_${k}">
    <bpmndi:BPMNPlane id="BPMNPlane_${k}" bpmnElement="Collab_${k}">
${shapes.join('\n')}
${edges.join('\n')}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
  const props: PropsMap = {};
  for (const p of spec.pools) for (const n of p.nodes) if (n.props) props[n.id] = n.props;
  return { bpmnXml, props, assets: spec.assets };
}
