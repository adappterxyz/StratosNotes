/**
 * Compile a workflow IR into the engine's WorkflowDef (programs/flow_engine/
 * src/def.rs) and its Borsh bytes. The definition is content-addressed: its
 * on-chain address is derived from the SHA-256 of these bytes, so the same
 * workflow compiles to the same account (Flow's __PKGHASH__, on Solana).
 */
import { sha256 } from '@noble/hashes/sha256';
import { compileExpr, compilePred, parseExpr, parsePred, type Op } from './expr';
import { dec } from './decimal';
import type { AssetOperation, IrNode, Issue, TemplateField, WorkflowIR } from './types';

export const DEF_VERSION = 1;
export const NO_EXPR = 0xffff;

export const KIND = { START: 0, END: 1, USER: 2, SERVICE: 3, RECEIVE: 4, XOR: 5, AND: 6, CATCH: 7 } as const;
export const FKIND = { Decimal: 0, Int: 1, Date: 2, Text: 3, Party: 4, Bool: 5 } as const;
export const SRC = { INPUT: 0, ORACLE: 1, EXPR: 2 } as const;
export const OP = { NONE: 0, MINT: 1, BURN: 2, TRANSFER: 3, SWAP: 4, DEPOSIT: 5, DISTRIBUTE: 6 } as const;
export const AKIND = { issued: 0, cash: 1 } as const;
export const CARRIED = '__carried__';

export type { Due, Capture, AssetOpDef, Edge, StepDef, WorkflowDef } from './def-types';
import type { Due, Capture, AssetOpDef, StepDef, WorkflowDef } from './def-types';

export interface Compiled {
  def: WorkflowDef;
  bytes: Uint8Array;
  hash: Uint8Array;
  /** Node id -> step index; field name -> index; role (pool) name -> index. */
  stepIndex: Record<string, number>;
  fieldIndex: Record<string, number>;
  roleIndex: Record<string, number>;
  assetIndex: Record<string, number>;
}

export class CompileError extends Error {
  constructor(public issues: Issue[]) { super(issues.map(i => i.message).join('; ')); }
}

/** Unix seconds from an ISO date/time or a number string. */
export function toUnix(v: string): bigint {
  if (/^\d+$/.test(v.trim())) return BigInt(v.trim());
  const t = Date.parse(/T/.test(v) ? v : `${v}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`not a date: ${v}`);
  return BigInt(Math.floor(t / 1000));
}

export function compile(ir: WorkflowIR, meta: unknown = {}): Compiled {
  const issues: Issue[] = [];
  const bad = (code: string, message: string, nodeId?: string) => { issues.push({ code, message, nodeId }); return 0; };

  // Fields: every template field across the workflow, one slot each.
  const fields: Array<{ name: string; kind: number }> = [];
  const fieldIndex: Record<string, number> = {};
  for (const n of ir.nodes) for (const f of n.props.templateFields ?? []) {
    const k = FKIND[f.type];
    if (k === undefined) { bad('FIELD_TYPE', `${n.name}: unknown field type ${f.type}`, n.id); continue; }
    if (f.name in fieldIndex) {
      if (fields[fieldIndex[f.name]].kind !== k) bad('FIELD_TYPE_CONFLICT', `Field '${f.name}' is declared with two types`, n.id);
      continue;
    }
    fieldIndex[f.name] = fields.length;
    fields.push({ name: f.name, kind: k });
  }
  const fieldOf = (name: string, nodeId?: string) => {
    if (!(name in fieldIndex)) { bad('UNKNOWN_FIELD', `'${name}' is not a workflow field`, nodeId); return 0; }
    return fieldIndex[name];
  };

  const roleIndex: Record<string, number> = {};
  ir.pools.forEach((p, i) => { roleIndex[p.name] = i; roleIndex[p.id] = i; });
  const roleOf = (name: string | undefined, nodeId: string) => {
    if (!name || !(name in roleIndex)) return bad('UNKNOWN_ROLE', `'${name ?? ''}' is not a pool`, nodeId);
    return roleIndex[name];
  };
  const assetIndex: Record<string, number> = {};
  ir.assets.forEach((a, i) => { assetIndex[a.id] = i; });
  const assetOf = (id: string | undefined, nodeId: string) => {
    if (!id || !(id in assetIndex)) return bad('UNKNOWN_ASSET', `'${id ?? ''}' is not a defined asset`, nodeId);
    return assetIndex[id];
  };

  // Expressions, de-duplicated.
  const exprs: Op[][] = [];
  const exprKey = new Map<string, number>();
  const intern = (ops: Op[]) => {
    const k = JSON.stringify(ops, (_, v) => typeof v === 'bigint' ? v.toString() : v);
    if (!exprKey.has(k)) { exprKey.set(k, exprs.length); exprs.push(ops); }
    return exprKey.get(k)!;
  };
  const expr = (src: string, nodeId: string) => {
    const r = parseExpr(src);
    if (!r.ok) return bad('BAD_EXPR', `'${src}': ${r.error}`, nodeId);
    return intern(compileExpr(r.ast, n => fieldOf(n, nodeId)));
  };
  const pred = (src: string, nodeId: string) => {
    const r = parsePred(src);
    if (!r.ok) return bad('BAD_CONDITION', `'${src}': ${r.error}`, nodeId);
    return intern(compilePred(r.ast, n => fieldOf(n, nodeId)));
  };
  const amountExpr = (src: AssetOperation['params']['amountSource'], literal: string | undefined, fieldName: string | undefined, e: string | undefined, nodeId: string) => {
    if (src === 'field') return expr(fieldName ?? '', nodeId);
    if (src === 'expr') return expr(e ?? '', nodeId);
    return expr(literal ?? '', nodeId);
  };
  const due = (t: { date?: string; dateField?: string } | undefined, nodeId: string): Due | null => {
    if (!t) return null;
    if (t.dateField) return { kind: 1, at: 0n, field: fieldOf(t.dateField, nodeId) };
    if (t.date) {
      try { return { kind: 0, at: toUnix(t.date), field: 0 }; } catch { bad('BAD_TIMER', `timer date '${t.date}' is not a date`, nodeId); }
    }
    return null;
  };

  const stepIndex: Record<string, number> = {};
  ir.nodes.forEach((n, i) => { stepIndex[n.id] = i; });
  const flowById = new Map(ir.flows.map(f => [f.id, f]));

  const op = (o: AssetOperation, n: IrNode): AssetOpDef => {
    const p = o.params ?? {};
    const none: AssetOpDef = { kind: OP.NONE, asset: 0, fromRole: 0, toRole: 0, amount: NO_EXPR, asset2: 0, fromRole2: 0, toRole2: 0, amount2: NO_EXPR, retire: false };
    const asset = assetOf(o.assetId, n.id);
    const amt = () => amountExpr(p.amountSource, p.amount, p.amountField, p.amountExpr, n.id);
    const self = roleIndex[ir.pools.find(x => x.id === n.pool)!.name];
    switch (o.operation) {
      case 'mint': return { ...none, kind: OP.MINT, asset, toRole: roleOf(p.owner, n.id), amount: amt() };
      case 'burn': return { ...none, kind: OP.BURN, asset, fromRole: roleOf(p.from ?? p.owner, n.id), amount: amt() };
      case 'transfer': return { ...none, kind: OP.TRANSFER, asset, fromRole: roleOf(p.from, n.id), toRole: roleOf(p.to, n.id), amount: amt() };
      case 'deposit': return { ...none, kind: OP.DEPOSIT, asset, fromRole: self, amount: amt() };
      case 'swap': {
        const d = roleOf(p.deliveryParty, n.id), pay = roleOf(p.paymentParty, n.id);
        return {
          ...none, kind: OP.SWAP, asset, fromRole: d, toRole: pay, amount: amt(),
          asset2: assetOf(p.counterAssetId, n.id), fromRole2: pay, toRole2: d,
          amount2: amountExpr(p.counterAmountSource, p.counterAmount, p.counterAmountField, p.counterAmountExpr, n.id),
        };
      }
      case 'distribute': return {
        ...none, kind: OP.DISTRIBUTE, asset, fromRole: roleOf(p.payer, n.id), amount: amt(),
        asset2: assetOf(p.holdingAssetId, n.id), retire: !!p.retire,
      };
      default: bad('BAD_OPERATION', `${n.name}: unknown operation ${(o as AssetOperation).operation}`, n.id); return none;
    }
  };

  const capture = (f: TemplateField, n: IrNode): Capture | null => {
    const idx = fieldOf(f.name, n.id);
    if (f.formula === CARRIED) return null; // one process account: nothing to carry
    if (f.oracle) {
      try { return { field: idx, source: SRC.ORACLE, expr: NO_EXPR, min: dec(f.oracle.min), max: dec(f.oracle.max) }; }
      catch { bad('BAD_ORACLE_BOUNDS', `${n.name}: oracle bounds for '${f.name}' must be numbers`, n.id); return null; }
    }
    if (f.formula) return { field: idx, source: SRC.EXPR, expr: expr(f.formula, n.id), min: 0n, max: 0n };
    return { field: idx, source: SRC.INPUT, expr: NO_EXPR, min: 0n, max: 0n };
  };

  const KIND_OF: Record<string, number> = {
    startEvent: KIND.START, endEvent: KIND.END, userTask: KIND.USER, serviceTask: KIND.SERVICE, task: KIND.SERVICE, sendTask: KIND.SERVICE,
    receiveTask: KIND.RECEIVE, exclusiveGateway: KIND.XOR, parallelGateway: KIND.AND, intermediateCatchEvent: KIND.CATCH,
  };

  const steps: StepDef[] = ir.nodes.map(n => {
    const kind = KIND_OF[n.type];
    const ops = [...(n.props.assetOperation ? [n.props.assetOperation] : []), ...(n.props.assetOperations ?? [])].map(o => op(o, n));
    return {
      id: n.id,
      kind,
      role: roleIndex[ir.pools.find(p => p.id === n.pool)?.name ?? ''] ?? bad('NO_POOL', `${n.name} is not in a pool`, n.id),
      timer: due(n.props.timer, n.id),
      guard: n.props.receiveGuard ? pred(n.props.receiveGuard, n.id) : NO_EXPR,
      captures: (n.props.templateFields ?? []).map(f => capture(f, n)).filter((c): c is Capture => !!c),
      ops,
      until: due(n.props.until, n.id),
      next: n.outgoing.map(fid => {
        const f = flowById.get(fid)!;
        return { target: stepIndex[f.target], cond: f.condition ? pred(f.condition, n.id) : NO_EXPR, isDefault: n.defaultFlow === fid };
      }),
      sends: ir.messageFlows.filter(m => m.source === n.id && m.target in stepIndex).map(m => stepIndex[m.target]),
      join: kind === KIND.AND && n.incoming.length > 1 ? n.incoming.length : 0,
    };
  });

  if (issues.length) throw new CompileError(issues);
  // Which price feed backs each oracle field: the CRE workflow reads it here.
  const oracles: Record<string, { feed: string; feedChain?: string; staleness?: number }> = {};
  for (const n of ir.nodes) for (const f of n.props.templateFields ?? []) {
    if (f.oracle) oracles[f.name] = { feed: f.oracle.feed, ...(f.oracle.feedChain ? { feedChain: f.oracle.feedChain } : {}), ...(f.oracle.staleness ? { staleness: f.oracle.staleness } : {}) };
  }
  const def: WorkflowDef = {
    version: DEF_VERSION, name: ir.name, meta: JSON.stringify({ ...(meta as object), oracles }),
    roles: ir.pools.map(p => p.name), fields,
    assets: ir.assets.map(a => ({ name: a.name, kind: AKIND[a.kind], decimals: a.decimals ?? 0 })),
    exprs, steps,
  };
  const bytes = encodeDef(def);
  return { def, bytes, hash: sha256(bytes), stepIndex, fieldIndex, roleIndex, assetIndex };
}

// ---- Borsh (field order mirrors def.rs exactly) ----------------------------

class W {
  private parts: number[] = [];
  u8(v: number) { this.parts.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  int(v: bigint, bytes: number) {
    let x = BigInt.asUintN(bytes * 8, v);
    for (let i = 0; i < bytes; i++) { this.u8(Number(x & 0xffn)); x >>= 8n; }
  }
  bool(v: boolean) { this.u8(v ? 1 : 0); }
  str(s: string) { const b = new TextEncoder().encode(s); this.u32(b.length); b.forEach(x => this.u8(x)); }
  vec<T>(xs: T[], f: (x: T) => void) { this.u32(xs.length); xs.forEach(f); }
  opt<T>(x: T | null, f: (x: T) => void) { if (x === null) this.u8(0); else { this.u8(1); f(x); } }
  done() { return Uint8Array.from(this.parts); }
}

export function encodeDef(d: WorkflowDef): Uint8Array {
  const w = new W();
  const due = (x: Due) => { w.u8(x.kind); w.int(x.at, 8); w.u16(x.field); };
  w.u8(d.version);
  w.str(d.name);
  w.str(d.meta);
  w.vec(d.roles, r => w.str(r));
  w.vec(d.fields, f => { w.str(f.name); w.u8(f.kind); });
  w.vec(d.assets, a => { w.str(a.name); w.u8(a.kind); w.u8(a.decimals); });
  w.vec(d.exprs, prog => w.vec(prog, o => { w.u8(o.code); w.u16(o.field); w.int(o.value, 8); }));
  w.vec(d.steps, s => {
    w.str(s.id);
    w.u8(s.kind);
    w.u8(s.role);
    w.opt(s.timer, due);
    w.u16(s.guard);
    w.vec(s.captures, c => { w.u16(c.field); w.u8(c.source); w.u16(c.expr); w.int(c.min, 8); w.int(c.max, 8); });
    w.vec(s.ops, o => { w.u8(o.kind); w.u8(o.asset); w.u8(o.fromRole); w.u8(o.toRole); w.u16(o.amount); w.u8(o.asset2); w.u8(o.fromRole2); w.u8(o.toRole2); w.u16(o.amount2); w.bool(o.retire); });
    w.opt(s.until, due);
    w.vec(s.next, e => { w.u16(e.target); w.u16(e.cond); w.bool(e.isDefault); });
    w.vec(s.sends, t => w.u16(t));
    w.u8(s.join);
  });
  return w.done();
}

/** Decode the engine's Report payload builder (CRE + tests): process, step, values. */
export function encodeReport(process: Uint8Array, step: number, values: bigint[]): Uint8Array {
  const w = new W();
  process.forEach(b => w.u8(b));
  w.u16(step);
  w.vec(values, v => w.int(v, 16));
  return w.done();
}
