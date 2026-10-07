/**
 * Workflow model: the per-node properties authored on the BPMN canvas (Flow's
 * CantonProperties, minus what only Canton needs) and the normalized IR the
 * compiler works on.
 */

export type FieldType = 'Decimal' | 'Int' | 'Date' | 'Text' | 'Party' | 'Bool';

export interface TemplateField {
  name: string;
  type: FieldType;
  /** A formula over other fields, computed when the step runs. */
  formula?: string;
  /** Delivered by Chainlink CRE from a price feed, checked against these bounds. */
  oracle?: { feed: string; feedChain?: string; min: string; max: string; staleness?: number };
}

export type AmountSource = 'literal' | 'field' | 'expr';

/**
 * Asset operations. Parties are named by POOL name (each pool is a role).
 *  - mint / burn / transfer: internal ledger moves of `assetId`.
 *  - swap: atomic DvP — `assetId` from deliveryParty to the payment party, and
 *    counterAssetId from paymentParty to the delivery party.
 *  - deposit: SPL cash from the step's own pool into the process vault.
 *  - distribute: pay every holder of holdingAssetId units x per-unit of
 *    assetId, from `payer` (optionally retiring the units).
 */
export interface AssetOperation {
  assetId: string;
  operation: 'mint' | 'burn' | 'transfer' | 'swap' | 'deposit' | 'distribute';
  params: {
    amountSource?: AmountSource;
    amount?: string;
    amountField?: string;
    amountExpr?: string;
    owner?: string; // mint: to
    from?: string; // burn / transfer
    to?: string; // transfer
    deliveryParty?: string; // swap
    paymentParty?: string;
    counterAssetId?: string;
    counterAmountSource?: AmountSource;
    counterAmount?: string;
    counterAmountField?: string;
    counterAmountExpr?: string;
    holdingAssetId?: string; // distribute
    payer?: string;
    retire?: boolean;
  };
}

export interface NodeProps {
  templateFields?: TemplateField[];
  assetOperation?: AssetOperation;
  /** Several operations, applied in order, atomically (after assetOperation). */
  assetOperations?: AssetOperation[];
  /**
   * Repeatable window (e.g. a subscription book): until this time anyone
   * holding the role may run the step again; then it closes and moves on.
   */
  until?: { date?: string; dateField?: string };
  /** Wait until a fixed time (ISO date or unix seconds) or a Date field's value. */
  timer?: { date?: string; dateField?: string };
  /** receiveTask: predicate the incoming message's fields must satisfy. */
  receiveGuard?: string;
  /** Kept from Flow imports; on Solana a step's role is its pool. */
  controllers?: string[];
}

export type PropsMap = Record<string, NodeProps>;

export interface AssetDefinition {
  id: string;
  name: string;
  /** issued: units only in the process ledger (e.g. the note). cash: an SPL token in the vault. */
  kind: 'issued' | 'cash';
  /** cash: the SPL token's decimals (USDC: 6). */
  decimals?: number;
  /**
   * cash: which cross-chain token this is (a symbol in deployments/*-tokens.json,
   * e.g. tUSD, tETH), so an app can map it to its mint on Solana and its
   * address on other CCIP chains. Not part of the compiled definition.
   */
  token?: string;
}

export type NodeType =
  | 'startEvent' | 'endEvent' | 'userTask' | 'serviceTask' | 'task' | 'receiveTask' | 'sendTask'
  | 'exclusiveGateway' | 'parallelGateway' | 'intermediateCatchEvent';

export interface IrNode {
  id: string;
  type: NodeType;
  name: string;
  pool: string; // participant id
  props: NodeProps;
  incoming: string[];
  outgoing: string[];
  defaultFlow?: string;
}

export interface IrFlow { id: string; source: string; target: string; name?: string; condition?: string }

export interface IrPool { id: string; name: string }

export interface WorkflowIR {
  name: string;
  pools: IrPool[];
  nodes: IrNode[];
  flows: IrFlow[];
  messageFlows: Array<{ id: string; source: string; target: string }>;
  assets: AssetDefinition[];
}

export interface Issue { code: string; message: string; nodeId?: string }
