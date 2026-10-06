/**
 * Client for the flow_engine program: addresses, instructions, accounts.
 * Works in Node (tests, scripts) and the browser (marketplace app).
 */
import { AnchorProvider, Program, type Idl } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idlJson from '../../idl/flow_engine.json';
import mockIdlJson from '../../idl/mock_forwarder.json';
import type { Compiled } from '../compile';
import { decodeDef } from '../decode';

export const ENGINE_IDL = idlJson as Idl;
export const ENGINE_PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);
export const MOCK_FORWARDER_IDL = mockIdlJson as Idl;
export const OPEN_ROLE = PublicKey.default;

const u64le = (n: bigint | number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

export const pda = {
  config: (program = ENGINE_PROGRAM_ID) => PublicKey.findProgramAddressSync([new TextEncoder().encode('config')], program)[0],
  definition: (hash: Uint8Array, program = ENGINE_PROGRAM_ID) => PublicKey.findProgramAddressSync([new TextEncoder().encode('def'), hash], program)[0],
  process: (definition: PublicKey, creator: PublicKey, id: bigint | number, program = ENGINE_PROGRAM_ID) =>
    PublicKey.findProgramAddressSync([new TextEncoder().encode('proc'), definition.toBytes(), creator.toBytes(), u64le(id)], program)[0],
  vault: (process: PublicKey, asset: number, program = ENGINE_PROGRAM_ID) =>
    PublicKey.findProgramAddressSync([new TextEncoder().encode('vault'), process.toBytes(), Uint8Array.of(asset)], program)[0],
};

// ---- Field values (engine `Slot`) -----------------------------------------

export interface Slot { tag: number; data: number[] }
const i128le = (v: bigint) => { const out: number[] = []; let x = BigInt.asUintN(128, v); for (let i = 0; i < 16; i++) { out.push(Number(x & 0xffn)); x >>= 8n; } return out; };
export const slot = {
  /** A fixed-point Decimal (already scaled by 1e10) or an Int / Date as a plain integer. */
  number: (v: bigint): Slot => ({ tag: 1, data: [...i128le(v), ...new Array(16).fill(0)] }),
  text: (s: string): Slot => {
    const b = [...new TextEncoder().encode(s)];
    if (b.length > 32) throw new Error(`'${s}' is longer than 32 bytes`);
    return { tag: 2, data: [...b, ...new Array(32 - b.length).fill(0)] };
  },
  key: (k: PublicKey): Slot => ({ tag: 3, data: [...k.toBytes()] }),
};

export function slotValue(s: Slot, kind: number): bigint | string | PublicKey | null {
  if (s.tag === 0) return null;
  const bytes = Uint8Array.from(s.data);
  if (s.tag === 2) return new TextDecoder().decode(bytes).replace(/\0+$/, '');
  if (s.tag === 3) return new PublicKey(bytes);
  let x = 0n;
  for (let i = 15; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]);
  void kind;
  return BigInt.asIntN(128, x);
}

const bnToBig = (b: BN | bigint | number) => BigInt(b.toString());

export interface ProcessAccount {
  address: PublicKey;
  definition: PublicKey;
  id: bigint;
  creator: PublicKey;
  status: number;
  roles: PublicKey[];
  mints: PublicKey[];
  tokens: number[];
  values: Slot[];
  holdings: Array<{ owner: PublicKey; asset: number; amount: bigint }>;
  createdAt: number;
  updatedAt: number;
  stepsRun: number;
}

// The IDL is loaded at runtime, so accounts and methods are untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = { methods: any; account: any; programId: PublicKey };

export class Engine {
  readonly program: AnyProgram;
  constructor(readonly provider: AnchorProvider) {
    this.program = new Program(ENGINE_IDL, provider) as unknown as AnyProgram;
  }
  get wallet() { return this.provider.wallet.publicKey; }

  /** Send and confirm; a failure carries the program logs. */
  async send(ixs: TransactionInstruction[], signers: import('@solana/web3.js').Signer[] = []) {
    try {
      return await this.provider.sendAndConfirm(new Transaction().add(...ixs), signers);
    } catch (e) {
      const err = e as { logs?: string[]; message?: string; getLogs?: (c: unknown) => Promise<string[]> };
      const logs = err.logs ?? (err.getLogs ? await err.getLogs(this.provider.connection).catch(() => undefined) : undefined);
      const tail = (logs ?? []).filter(l => /Error|error|failed|AnchorError/.test(l)).slice(-4).join(' | ');
      throw new Error(`${err.message ?? String(e)}${tail ? ` :: ${tail}` : ''}`);
    }
  }

  initConfig(forwarders: PublicKey[]) {
    return this.program.methods.initConfig(forwarders).accounts({ admin: this.wallet }).instruction();
  }

  /** Create, write in chunks and seal a definition (skips what already exists). */
  async publish(c: Compiled, chunk = 850): Promise<PublicKey> {
    const address = pda.definition(c.hash);
    const existing = await this.program.account.definition.fetchNullable(address) as { sealed: boolean; data: Buffer } | null;
    if (existing?.sealed) return address;
    if (!existing) {
      await this.send([await this.program.methods.createDefinition([...c.hash], c.bytes.length).accounts({ creator: this.wallet }).instruction()]);
    }
    const written = existing ? existing.data.length : 0;
    for (let o = written; o < c.bytes.length; o += chunk) {
      const part = Buffer.from(c.bytes.subarray(o, o + chunk));
      await this.send([await this.program.methods.writeDefinition(part).accounts({ definition: address, creator: this.wallet }).instruction()]);
    }
    await this.send([await this.program.methods.sealDefinition().accounts({ definition: address, creator: this.wallet }).instruction()]);
    return address;
  }

  startProcess(definition: PublicKey, id: bigint, roles: PublicKey[], mints: PublicKey[], startStep: number, inputs: Slot[] = []) {
    return this.program.methods.startProcess(new BN(id.toString()), roles, mints, startStep, inputs)
      .accounts({ definition, signer: this.wallet }).instruction();
  }

  openVault(process: PublicKey, asset: number, mint: PublicKey) {
    return this.program.methods.openVault(asset).accountsPartial({ process, mint, vault: pda.vault(process, asset), payer: this.wallet, tokenProgram: TOKEN_PROGRAM_ID }).instruction();
  }

  /** Run a step; pass `deposit` when the step takes cash from the signer. */
  executeStep(process: PublicKey, definition: PublicKey, step: number, inputs: Slot[], opts: { choice?: number; deposit?: { asset: number; mint: PublicKey } } = {}) {
    const d = opts.deposit;
    // Optional accounts: null when the step takes no deposit.
    const accounts = {
      process, definition, signer: this.wallet,
      mint: d ? d.mint : null,
      fromToken: d ? getAssociatedTokenAddressSync(d.mint, this.wallet) : null,
      vault: d ? pda.vault(process, d.asset) : null,
      tokenProgram: d ? TOKEN_PROGRAM_ID : null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.program.methods.executeStep(step, opts.choice ?? null, inputs).accountsPartial(accounts as any).instruction();
  }

  poke(process: PublicKey, definition: PublicKey) {
    return this.program.methods.poke().accounts({ process, definition }).instruction();
  }

  deposit(process: PublicKey, definition: PublicKey, asset: number, mint: PublicKey, base: bigint) {
    return this.program.methods.deposit(asset, new BN(base.toString())).accountsPartial({
      process, definition, signer: this.wallet, mint, fromToken: getAssociatedTokenAddressSync(mint, this.wallet), vault: pda.vault(process, asset), tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
  }

  withdraw(process: PublicKey, definition: PublicKey, asset: number, mint: PublicKey, base: bigint) {
    return this.program.methods.withdraw(asset, new BN(base.toString())).accountsPartial({
      process, definition, signer: this.wallet, mint, toToken: getAssociatedTokenAddressSync(mint, this.wallet), vault: pda.vault(process, asset), tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
  }

  /** Move note units (an issued asset), in whole or in part; `amount` is fixed point (dec()). */
  transferUnits(process: PublicKey, definition: PublicKey, asset: number, to: PublicKey, amount: bigint) {
    return this.program.methods.transferUnits(asset, to, new BN(amount.toString())).accountsPartial({ process, definition, signer: this.wallet }).instruction();
  }

  async definition(address: PublicKey) {
    const d = await this.program.account.definition.fetch(address) as { sealed: boolean; data: Buffer; hash: number[] };
    return { address, sealed: d.sealed, def: decodeDef(Uint8Array.from(d.data)) };
  }

  async process(address: PublicKey): Promise<ProcessAccount> {
    return toProcess(address, await this.program.account.process.fetch(address));
  }

  /** Every process (optionally of one definition). */
  async processes(definition?: PublicKey): Promise<ProcessAccount[]> {
    const filters = definition ? [{ memcmp: { offset: 8, bytes: definition.toBase58() } }] : [];
    const all = await this.program.account.process.all(filters);
    return all.map((a: { publicKey: PublicKey; account: unknown }) => toProcess(a.publicKey, a.account));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProcess(address: PublicKey, a: any): ProcessAccount {
  return {
    address,
    definition: a.definition,
    id: bnToBig(a.id),
    creator: a.creator,
    status: a.status,
    roles: a.roles,
    mints: a.mints,
    tokens: a.tokens,
    values: a.values,
    holdings: a.holdings.map((h: { owner: PublicKey; asset: number; amount: BN }) => ({ owner: h.owner, asset: h.asset, amount: bnToBig(h.amount) })),
    createdAt: Number(a.createdAt),
    updatedAt: Number(a.updatedAt),
    stepsRun: a.stepsRun,
  };
}

export { SystemProgram };
