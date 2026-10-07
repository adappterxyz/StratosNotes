/**
 * How to issue a workflow, read from the workflow itself so it works for stock
 * products and custom notes alike:
 *  - roles: a pool with a repeatable window (the subscription book) is open to
 *    anyone; every other pool is held by the issuer's wallet;
 *  - the issuer starts at the start event of a pool it holds (Issuer first);
 *  - the pre-trade steps are the user tasks that follow that start event in
 *    the same pool (a product's Approve Terms and Mandate Paying Agent). Their
 *    input fields become the issue form, and a step that deposits cash takes it
 *    from the issuer's wallet.
 */
import { PublicKey } from '@solana/web3.js';
import { FKIND, OPEN_ROLE, OP, SRC, type Compiled, type WorkflowIR } from '@stratosnotes/flow';

export interface PlanInput { name: string; kind: number }
export interface PlanStep { id: string; name: string; index: number; inputs: PlanInput[]; deposit: number | null }
export interface IssuePlan {
  start: PlanStep;
  /** User tasks run right after the start, in order. */
  steps: PlanStep[];
  openPools: string[];
  heldPools: string[];
  cashAssets: number[];
  /** Product-shaped schedule: a strike date and observation dates. */
  dateFields: string[];
}

export function planIssuance(ir: WorkflowIR, c: Compiled): IssuePlan {
  const open = new Set(ir.nodes.filter(n => n.props.until).map(n => n.pool));
  const starts = ir.nodes.filter(n => n.type === 'startEvent' && !open.has(n.pool));
  const poolName = (id: string) => ir.pools.find(p => p.id === id)?.name ?? id;
  const start = starts.find(n => /issuer/i.test(poolName(n.pool))) ?? starts[0];
  if (!start) throw new Error('The workflow needs a start event in a pool the issuer holds (one without a subscription window).');
  const step = (id: string): PlanStep => {
    const index = c.stepIndex[id];
    const s = c.def.steps[index];
    const node = ir.nodes.find(n => n.id === id)!;
    const dep = s.ops.find(o => o.kind === OP.DEPOSIT);
    return {
      id, name: node.name || id, index,
      inputs: s.captures.filter(x => x.source === SRC.INPUT).map(x => ({ name: c.def.fields[x.field].name, kind: c.def.fields[x.field].kind })),
      deposit: dep ? dep.asset : null,
    };
  };
  const steps: PlanStep[] = [];
  const flowsFrom = (id: string) => ir.flows.filter(f => f.source === id);
  let at: string | undefined = flowsFrom(start.id)[0]?.target;
  const seen = new Set<string>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const n = ir.nodes.find(x => x.id === at);
    if (!n || n.type !== 'userTask' || n.pool !== start.pool) break;
    steps.push(step(n.id));
    const out = flowsFrom(n.id);
    at = out.length === 1 ? out[0].target : undefined;
  }
  const all = [step(start.id), ...steps].flatMap(s => s.inputs);
  return {
    start: step(start.id), steps,
    openPools: ir.pools.filter(p => open.has(p.id)).map(p => p.name),
    heldPools: ir.pools.filter(p => !open.has(p.id)).map(p => p.name),
    cashAssets: ir.assets.map((a, i) => (a.kind === 'cash' ? i : -1)).filter(i => i >= 0),
    dateFields: all.filter(f => f.kind === FKIND.Date && /^(strikeDate|obsDate\d+)$/.test(f.name)).map(f => f.name),
  };
}

export function rolesFor(ir: WorkflowIR, issuer: PublicKey) {
  const open = new Set(ir.nodes.filter(n => n.props.until).map(n => n.pool));
  return ir.pools.map(p => (open.has(p.id) ? OPEN_ROLE : issuer));
}

/** "obsDate3" -> 3; strikeDate -> 0. */
export const obsIndex = (name: string) => (name === 'strikeDate' ? 0 : Number(name.replace('obsDate', '')));

export const FIELD_LABEL: Record<string, string> = {
  isin: 'ISIN / reference', notional: 'Size (units of 1 USDC)', strikeDate: 'Strike date (book closes)', reserve: 'Coupon reserve (USDC)', units: 'Units',
};
