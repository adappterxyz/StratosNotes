/**
 * What the CRE keeper decides, as pure functions (no I/O, no Node APIs: this
 * file is bundled into the CRE workflow's WASM and unit-tested here).
 *
 * Given the engine's running Process accounts and their Definitions (raw
 * account bytes), list the oracle steps that are due: a token sits on a
 * service step that captures an oracle field, and its date has come. The
 * keeper then reads each step's price feed and writes a report.
 */
import { decodeDef } from './decode';
import type { WorkflowDef } from './def-types';

const KIND_SERVICE = 3, KIND_CATCH = 7, SRC_ORACLE = 1;

export interface RawProcess {
  definition: Uint8Array; // 32 bytes
  id: bigint;
  status: number;
  tokens: number[];
  values: Array<{ tag: number; data: Uint8Array }>;
}

/** Process account bytes (with discriminator) -> the fields the keeper needs. */
export function decodeProcess(data: Uint8Array): RawProcess {
  let o = 8;
  const u8 = () => data[o++];
  const u16 = () => { const v = data[o] | (data[o + 1] << 8); o += 2; return v; };
  const u32 = () => { const v = data[o] + data[o + 1] * 0x100 + data[o + 2] * 0x10000 + data[o + 3] * 0x1000000; o += 4; return v; };
  const bytes = (n: number) => { const b = data.subarray(o, o + n); o += n; return b; };
  const definition = bytes(32);
  let id = 0n;
  for (let i = 7; i >= 0; i--) id = (id << 8n) | BigInt(data[o + i]);
  o += 8;
  bytes(32); // creator
  u8(); // bump
  const status = u8();
  bytes(32 * u32()); // roles
  bytes(32 * u32()); // mints
  const tokens = Array.from({ length: u32() }, u16);
  const values = Array.from({ length: u32() }, () => ({ tag: u8(), data: bytes(32) }));
  return { definition, id, status, tokens, values };
}

/** Definition account bytes -> its workflow (null if not sealed). */
export function decodeDefinitionAccount(data: Uint8Array): WorkflowDef | null {
  if (data.length < 81 || data[72] !== 1) return null;
  const n = data[77] + data[78] * 0x100 + data[79] * 0x10000 + data[80] * 0x1000000;
  return decodeDef(data.subarray(81, 81 + n));
}

const slotInt = (s: { tag: number; data: Uint8Array }) => {
  let x = 0n;
  for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(s.data[i]);
  return BigInt.asIntN(128, x);
};

export interface DueOracle {
  process: string; // base58 filled in by the caller
  definition: string;
  step: number;
  stepId: string;
  /** One per oracle capture, in order. */
  feeds: Array<{ field: string; feed: string; feedChain: string; staleness: number }>;
}

/** Oracle steps of one process that may run at `nowSec`. */
export function dueOracleSteps(p: RawProcess, def: WorkflowDef, nowSec: number): Array<Omit<DueOracle, 'process' | 'definition'>> {
  if (p.status !== 0) return [];
  let oracles: Record<string, { feed: string; feedChain?: string; staleness?: number }> = {};
  try { oracles = (JSON.parse(def.meta) as { oracles?: typeof oracles }).oracles ?? {}; } catch { /* no feeds */ }
  const out: Array<Omit<DueOracle, 'process' | 'definition'>> = [];
  for (const t of [...new Set(p.tokens)].sort((a, b) => a - b)) {
    const s = def.steps[t];
    if (!s || (s.kind !== KIND_SERVICE && s.kind !== KIND_CATCH)) continue;
    const caps = s.captures.filter(c => c.source === SRC_ORACLE);
    if (!caps.length) continue;
    if (s.timer) {
      const due = s.timer.kind === 0 ? Number(s.timer.at) : (p.values[s.timer.field]?.tag ? Number(slotInt(p.values[s.timer.field])) : NaN);
      if (!(nowSec >= due)) continue;
    }
    const feeds = caps.map(c => {
      const name = def.fields[c.field].name;
      const o = oracles[name];
      return o ? { field: name, feed: o.feed, feedChain: o.feedChain ?? 'ethereum-mainnet', staleness: o.staleness ?? 3600 } : null;
    });
    if (feeds.some(f => !f)) continue; // no feed recorded: cannot observe
    out.push({ step: t, stepId: s.id, feeds: feeds as DueOracle['feeds'] });
  }
  return out;
}

/** Chainlink answer (feed decimals) -> engine fixed point (10 decimals). */
export function feedToFixed(answer: bigint, decimals: number): bigint {
  return decimals <= 10 ? answer * 10n ** BigInt(10 - decimals) : answer / 10n ** BigInt(decimals - 10);
}

/** Report payload the engine's on_report decodes: process, step, values (i128 LE). */
export function reportPayload(process: Uint8Array, step: number, values: bigint[]): Uint8Array {
  const out = new Uint8Array(32 + 2 + 4 + 16 * values.length);
  out.set(process, 0);
  out[32] = step & 0xff; out[33] = step >> 8;
  new DataView(out.buffer).setUint32(34, values.length, true);
  values.forEach((v, i) => { let x = BigInt.asUintN(128, v); for (let b = 0; b < 16; b++) { out[38 + 16 * i + b] = Number(x & 0xffn); x >>= 8n; } });
  return out;
}
