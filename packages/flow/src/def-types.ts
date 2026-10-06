/**
 * The engine's WorkflowDef as TypeScript types (mirrors programs/flow_engine/
 * src/def.rs). Dependency-free so the CRE workflow can bundle it.
 */
import type { Op } from './op';

export interface Due { kind: number; at: bigint; field: number }
export interface Capture { field: number; source: number; expr: number; min: bigint; max: bigint }
export interface AssetOpDef { kind: number; asset: number; fromRole: number; toRole: number; amount: number; asset2: number; fromRole2: number; toRole2: number; amount2: number; retire: boolean }
export interface Edge { target: number; cond: number; isDefault: boolean }
export interface StepDef {
  id: string; kind: number; role: number; timer: Due | null; guard: number; captures: Capture[];
  ops: AssetOpDef[]; until: Due | null; next: Edge[]; sends: number[]; join: number;
}
export interface WorkflowDef {
  version: number; name: string; meta: string; roles: string[];
  fields: Array<{ name: string; kind: number }>;
  assets: Array<{ name: string; kind: number; decimals: number }>;
  exprs: Op[][];
  steps: StepDef[];
}

