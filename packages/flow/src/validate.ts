/**
 * Structural checks a workflow must pass before it can be published (Flow's
 * validate.ts, for the Solana engine). The compiler's own errors (unknown
 * fields, pools, assets, bad expressions) are added by `check`.
 */
import { compile, CompileError } from './compile';
import { parseExpr, parsePred } from './expr';
import type { Issue, IrNode, WorkflowIR } from './types';

const isTask = (t: string) => ['userTask', 'serviceTask', 'task', 'receiveTask', 'sendTask'].includes(t);

export function validate(ir: WorkflowIR): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (code: string, message: string, nodeId?: string) => errors.push({ code, message, nodeId });
  const warn = (code: string, message: string, nodeId?: string) => warnings.push({ code, message, nodeId });
  const byId = new Map(ir.nodes.map(n => [n.id, n]));
  const flowById = new Map(ir.flows.map(f => [f.id, f]));
  const label = (n: IrNode) => `'${n.name || n.id}'`;
  const fieldTypes = new Map<string, string>();
  for (const n of ir.nodes) for (const f of n.props.templateFields ?? []) fieldTypes.set(f.name, f.type);

  if (!ir.nodes.some(n => n.type === 'startEvent')) err('NO_START', 'The workflow needs a start event.');
  for (const p of ir.pools) {
    const own = ir.nodes.filter(n => n.pool === p.id);
    if (!own.length) { err('EMPTY_POOL', `Pool '${p.name}' has no steps.`); continue; }
    const entry = own.some(n => n.type === 'startEvent' || ir.messageFlows.some(m => m.target === n.id));
    if (!entry) err('POOL_NO_ENTRY', `Pool '${p.name}' has no start event and receives no message, so it never starts.`);
  }

  // Reachability from start events and message targets.
  const seen = new Set<string>();
  const queue = ir.nodes.filter(n => n.type === 'startEvent').map(n => n.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    for (const fid of n.outgoing) { const f = flowById.get(fid); if (f) queue.push(f.target); }
    for (const m of ir.messageFlows) if (m.source === id) queue.push(m.target);
  }
  for (const n of ir.nodes) {
    if (!seen.has(n.id)) warn('UNREACHABLE', `${label(n)} can never be reached.`, n.id);
    if (n.type !== 'endEvent' && !n.outgoing.length) err('DEAD_END', `${label(n)} has no outgoing flow; end every path with an end event.`, n.id);
    if (n.type === 'endEvent' && n.outgoing.length) err('END_HAS_OUTGOING', `End event ${label(n)} has an outgoing flow.`, n.id);
    if (n.type === 'startEvent' && n.incoming.length) err('START_HAS_INCOMING', `Start event ${label(n)} has an incoming flow.`, n.id);
  }

  for (const n of ir.nodes) {
    const p = n.props;
    // Gateways: conditions and defaults.
    if (n.type === 'exclusiveGateway' && n.outgoing.length > 1) {
      const outs = n.outgoing.map(f => flowById.get(f)!).filter(Boolean);
      const conditioned = outs.filter(f => f.condition);
      if (conditioned.length && conditioned.length < outs.length - 1) err('GATEWAY_CONDITIONS', `Gateway ${label(n)}: give every branch but one a condition (the other is the default), or none (a person chooses).`, n.id);
      if (conditioned.length && !n.defaultFlow && conditioned.length === outs.length) warn('GATEWAY_NO_DEFAULT', `Gateway ${label(n)} has no default branch: when no condition holds it waits forever.`, n.id);
      for (const f of conditioned) {
        const r = parsePred(f.condition!);
        if (!r.ok) err('BAD_CONDITION', `Gateway ${label(n)}: '${f.condition}': ${r.error}`, n.id);
        else for (const ref of r.refs) if (!fieldTypes.has(ref)) err('CONDITION_FIELD', `Gateway ${label(n)}: '${ref}' is not a workflow field.`, n.id);
      }
    }
    if (n.type !== 'exclusiveGateway') for (const fid of n.outgoing) if (flowById.get(fid)?.condition) warn('CONDITION_IGNORED', `${label(n)}: conditions only apply on exclusive gateways.`, n.id);

    // Fields: oracle values only on automatic steps; inputs only where a person acts.
    for (const f of p.templateFields ?? []) {
      if (f.oracle && n.type !== 'serviceTask' && n.type !== 'intermediateCatchEvent') err('ORACLE_STEP', `${label(n)}: '${f.name}' comes from a price feed, which only an automatic (service) step can capture.`, n.id);
      if (f.oracle && !/^0x[0-9a-fA-F]{40}$/.test(f.oracle.feed)) err('ORACLE_FEED', `${label(n)}: '${f.name}' needs a Chainlink feed address.`, n.id);
      if (f.formula && f.formula !== '__carried__') { const r = parseExpr(f.formula); if (!r.ok) err('BAD_FORMULA', `${label(n)}: formula for '${f.name}': ${r.error}`, n.id); }
      const input = !f.oracle && !f.formula;
      if (input && n.type === 'serviceTask') warn('SERVICE_INPUT', `${label(n)} is automatic but '${f.name}' is entered by a person: it will wait for its pool to run it.`, n.id);
      if (input && !isTask(n.type) && n.type !== 'startEvent') err('INPUT_STEP', `${label(n)} cannot capture '${f.name}'.`, n.id);
    }
    for (const t of [p.timer, p.until]) if (t?.dateField && fieldTypes.get(t.dateField) !== 'Date') err('TIMER_FIELD', `${label(n)}: '${t.dateField}' must be a Date field.`, n.id);
    if (p.until && n.type !== 'userTask') err('WINDOW_STEP', `${label(n)}: a repeatable window ("until") goes on a user task.`, n.id);
    if (p.receiveGuard) { const r = parsePred(p.receiveGuard); if (!r.ok) err('BAD_GUARD', `${label(n)}: guard: ${r.error}`, n.id); }
    for (const o of [...(p.assetOperation ? [p.assetOperation] : []), ...(p.assetOperations ?? [])]) {
      if (o.operation === 'deposit' && n.type !== 'userTask') err('DEPOSIT_STEP', `${label(n)}: a deposit takes cash from the person running the step, so it goes on a user task.`, n.id);
      if (o.operation === 'deposit' && ir.assets.find(a => a.id === o.assetId)?.kind !== 'cash') err('DEPOSIT_ASSET', `${label(n)}: only a cash asset can be deposited.`, n.id);
    }
  }
  for (const f of ir.flows) {
    const s = byId.get(f.source), t = byId.get(f.target);
    if (!s || !t) err('FLOW_ENDS', `Sequence flow ${f.id} does not connect two steps.`);
    else if (s.pool !== t.pool) err('FLOW_CROSSES_POOL', `${label(s)} -> ${label(t)} crosses pools: use a message flow between pools.`, s.id);
  }
  for (const m of ir.messageFlows) {
    const s = byId.get(m.source), t = byId.get(m.target);
    if (!s || !t) { err('MESSAGE_ENDS', `Message flow ${m.id} does not connect two steps.`); continue; }
    if (s.pool === t.pool) warn('MESSAGE_SAME_POOL', `Message from ${label(s)} to ${label(t)} stays in one pool; use a sequence flow.`, s.id);
  }
  return { errors, warnings };
}

/** Everything that blocks publishing: structural errors, then the compiler's. */
export function check(ir: WorkflowIR): { errors: Issue[]; warnings: Issue[] } {
  const r = validate(ir);
  try { compile(ir); } catch (e) {
    if (e instanceof CompileError) r.errors.push(...e.issues.filter(i => !r.errors.some(x => x.message === i.message)));
    else r.errors.push({ code: 'COMPILE', message: e instanceof Error ? e.message : String(e) });
  }
  return r;
}
