/**
 * Read a WorkflowDef back from its Borsh bytes (the Definition account's
 * data): the marketplace renders offerings from it, and the CRE workflow uses
 * it to find the oracle steps that are due.
 */
import type { WorkflowDef, StepDef, Due } from './def-types';

class R {
  private o = 0;
  constructor(private b: Uint8Array) {}
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b[this.o] | (this.b[this.o + 1] << 8); this.o += 2; return v; }
  u32() { const v = (this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16)) + this.b[this.o + 3] * 0x1000000; this.o += 4; return v; }
  int(bytes: number, signed = true) {
    let x = 0n;
    for (let i = bytes - 1; i >= 0; i--) x = (x << 8n) | BigInt(this.b[this.o + i]);
    this.o += bytes;
    return signed ? BigInt.asIntN(bytes * 8, x) : x;
  }
  bool() { return this.u8() !== 0; }
  str() { const n = this.u32(); const s = new TextDecoder().decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  vec<T>(f: () => T): T[] { const n = this.u32(); return Array.from({ length: n }, f); }
  opt<T>(f: () => T): T | null { return this.u8() ? f() : null; }
}

export function decodeDef(bytes: Uint8Array): WorkflowDef {
  const r = new R(bytes);
  const due = (): Due => ({ kind: r.u8(), at: r.int(8), field: r.u16() });
  const version = r.u8();
  const name = r.str();
  const meta = r.str();
  const roles = r.vec(() => r.str());
  const fields = r.vec(() => ({ name: r.str(), kind: r.u8() }));
  const assets = r.vec(() => ({ name: r.str(), kind: r.u8(), decimals: r.u8() }));
  const exprs = r.vec(() => r.vec(() => ({ code: r.u8(), field: r.u16(), value: r.int(8) })));
  const steps = r.vec((): StepDef => ({
    id: r.str(),
    kind: r.u8(),
    role: r.u8(),
    timer: r.opt(due),
    guard: r.u16(),
    captures: r.vec(() => ({ field: r.u16(), source: r.u8(), expr: r.u16(), min: r.int(8), max: r.int(8) })),
    ops: r.vec(() => ({ kind: r.u8(), asset: r.u8(), fromRole: r.u8(), toRole: r.u8(), amount: r.u16(), asset2: r.u8(), fromRole2: r.u8(), toRole2: r.u8(), amount2: r.u16(), retire: r.bool() })),
    until: r.opt(due),
    next: r.vec(() => ({ target: r.u16(), cond: r.u16(), isDefault: r.bool() })),
    sends: r.vec(() => r.u16()),
    join: r.u8(),
  }));
  return { version, name, meta, roles, fields, assets, exprs, steps };
}
