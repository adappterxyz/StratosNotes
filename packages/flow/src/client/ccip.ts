/**
 * Chainlink CCIP for the engine (see docs/crosschain.md).
 *
 *  - Remote holders: an EVM address on a CCIP chain, as the 32-byte key the
 *    engine uses for it in the holdings ledger.
 *  - Inbound: what a Sepolia sender puts in a CCIP message to the engine (the
 *    payload, the accounts the engine needs, the SVM extra args).
 *  - Outbound: the router's `ccip_send` accounts for `withdraw_remote`, with
 *    the engine's sender PDA as authority and the fee paid in native SOL.
 */
import { PublicKey, type AccountMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Slot } from './engine';

export const CCIP = {
  devnet: {
    router: new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C'),
    feeQuoter: new PublicKey('FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi'),
    rmnRemote: new PublicKey('RmnXLft1mSEwDgMKu2okYuHkiazxntFFcZFrrcXxYg7'),
    linkMint: new PublicKey('LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L'),
    poolProgram: new PublicKey('41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB'),
    selector: 16423721717087811551n,
  },
  sepolia: {
    router: '0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59',
    selector: 16015286601757825753n,
    chainId: 11155111,
  },
} as const;

const u64le = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const enc = (s: string) => new TextEncoder().encode(s);

// ---- Engine PDAs ------------------------------------------------------------

export const ccipPda = {
  config: (engine: PublicKey) => PublicKey.findProgramAddressSync([enc('ccip_config')], engine)[0],
  /** CCIP delivers inbound tokens to this PDA's token accounts (the message's token receiver). */
  inbox: (engine: PublicKey) => PublicKey.findProgramAddressSync([enc('ccip_inbox')], engine)[0],
  /** Signs outbound `ccip_send` and pays its fee in SOL. */
  sender: (engine: PublicKey) => PublicKey.findProgramAddressSync([enc('ccip_sender')], engine)[0],
};

// ---- Remote holders -----------------------------------------------------------

const hex = (s: string) => Uint8Array.from((s.replace(/^0x/, '').match(/../g) ?? []).map(h => parseInt(h, 16)));

/** The engine's key for an EVM address on CCIP chain `chain` (index into the engine's CCIP chains). */
export function remoteKey(chain: number, evmAddress: string): PublicKey {
  const a = hex(evmAddress);
  if (a.length !== 20) throw new Error(`not an EVM address: ${evmAddress}`);
  const b = new Uint8Array(32);
  b[0] = chain + 1;
  b.set(a, 12);
  return new PublicKey(b);
}

/** (chain index, EVM address) if `key` is a remote holder. */
export function remoteOf(key: PublicKey): { chain: number; address: string } | null {
  const b = key.toBytes();
  if (b[0] === 0 || b[0] > 4 || b.slice(1, 12).some(x => x !== 0)) return null;
  return { chain: b[0] - 1, address: '0x' + Array.from(b.slice(12), x => x.toString(16).padStart(2, '0')).join('') };
}

// ---- Inbound: what the Sepolia side sends -------------------------------------------

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 0xff); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  key(k: PublicKey) { this.b.push(...k.toBytes()); }
  out() { return Uint8Array.from(this.b); }
}

/** CcipCall::Run: run a user step (e.g. subscribe) as the sender; the message's tokens fund its deposit. */
export function encodeRun(process: PublicKey, step: number, inputs: Slot[]): Uint8Array {
  const w = new W();
  w.u8(0); w.key(process); w.u16(step); w.u32(inputs.length);
  for (const s of inputs) { w.u8(s.tag); s.data.forEach(x => w.u8(x)); }
  return w.out();
}

/** CcipCall::Deposit: credit the message's tokens to a role (e.g. the issuer's reserve). */
export function encodeDeposit(process: PublicKey, role: number): Uint8Array {
  const w = new W();
  w.u8(1); w.key(process); w.u8(role);
  return w.out();
}

/**
 * The engine accounts a CCIP message must list (SVM extra args), in
 * `ccip_receive` order after CCIP's own three, with the writable bitmap.
 */
export function receiveAccounts(engine: PublicKey, process: PublicKey, definition: PublicKey, mint: PublicKey, asset: number) {
  const inbox = ccipPda.inbox(engine);
  const vault = PublicKey.findProgramAddressSync([enc('vault'), process.toBytes(), Uint8Array.of(asset)], engine)[0];
  const accounts = [
    ccipPda.config(engine), // 0
    process, // 1 writable
    definition, // 2
    inbox, // 3
    getAssociatedTokenAddressSync(mint, inbox, true), // 4 writable
    vault, // 5 writable
    TOKEN_PROGRAM_ID, // 6
  ];
  return { accounts, writableBitmap: (1n << 1n) | (1n << 4n) | (1n << 5n), tokenReceiver: inbox };
}

/** CCIP SVMExtraArgsV1 (ABI-encoded, tagged) for an EVM -> Solana message to the engine. */
export function svmExtraArgs(opts: { computeUnits: number; writableBitmap: bigint; tokenReceiver: PublicKey; accounts: PublicKey[] }): string {
  const word = (h: string) => h.padStart(64, '0');
  const b32 = (k: PublicKey) => Array.from(k.toBytes(), x => x.toString(16).padStart(2, '0')).join('');
  // tuple(uint32 computeUnits, uint64 bitmap, bool ooo, bytes32 tokenReceiver, bytes32[] accounts): dynamic -> offset first.
  const head = [word('20'), word(opts.computeUnits.toString(16)), word(opts.writableBitmap.toString(16)), word('1'), b32(opts.tokenReceiver), word((5 * 32).toString(16))];
  const tail = [word(opts.accounts.length.toString(16)), ...opts.accounts.map(b32)];
  return '0x1f3b3aba' + [...head, ...tail].join('');
}

// ---- Outbound: the router's ccip_send accounts --------------------------------------

/**
 * Accounts for the router's `ccip_send` (in order), with the engine's sender
 * PDA as authority and the fee in native SOL, then the token's accounts
 * (from its CCIP lookup table), then the router program for the CPI.
 * `lookupTable` and `writableIndexes` come from the token's registration
 * (deployments/solana-tokens.json: writable indexes [3, 4, 7]).
 */
export function ccipSendAccounts(opts: {
  engine: PublicKey; mint: PublicKey; destSelector: bigint; lookupTableAddresses: PublicKey[];
  writableIndexes?: number[]; net?: typeof CCIP.devnet;
}): AccountMeta[] {
  const net = opts.net ?? CCIP.devnet;
  const sender = ccipPda.sender(opts.engine);
  const r = (seeds: Uint8Array[], p: PublicKey) => PublicKey.findProgramAddressSync(seeds, p)[0];
  const feeBillingSigner = r([enc('fee_billing_signer')], net.router);
  const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const writable = new Set(opts.writableIndexes ?? [3, 4, 7]);
  const alt = opts.lookupTableAddresses;
  return [
    ro(r([enc('config')], net.router)),
    rw(r([enc('dest_chain_state'), u64le(opts.destSelector)], net.router)),
    rw(r([enc('nonce'), u64le(opts.destSelector), sender.toBytes()], net.router)),
    { pubkey: sender, isSigner: false, isWritable: true }, // authority: the engine signs for it in the CPI
    ro(new PublicKey('11111111111111111111111111111111')),
    ro(TOKEN_PROGRAM_ID), // fee token program (native SOL: wrapped SOL's)
    ro(NATIVE_MINT),
    rw(PublicKey.default), // fee token user ATA: none when paying in native SOL
    rw(getAssociatedTokenAddressSync(NATIVE_MINT, feeBillingSigner, true)),
    ro(feeBillingSigner),
    ro(net.feeQuoter),
    ro(r([enc('config')], net.feeQuoter)),
    ro(r([enc('dest_chain'), u64le(opts.destSelector)], net.feeQuoter)),
    ro(r([enc('fee_billing_token_config'), NATIVE_MINT.toBytes()], net.feeQuoter)),
    ro(r([enc('fee_billing_token_config'), net.linkMint.toBytes()], net.feeQuoter)),
    ro(net.rmnRemote),
    ro(r([enc('curses')], net.rmnRemote)),
    ro(r([enc('config')], net.rmnRemote)),
    // The token: the authority's token account, billing config, pool chain config, then the lookup table's entries.
    rw(getAssociatedTokenAddressSync(opts.mint, sender, true)),
    ro(r([enc('per_chain_per_token_config'), u64le(opts.destSelector), opts.mint.toBytes()], net.feeQuoter)),
    rw(r([enc('ccip_tokenpool_chainconfig'), u64le(opts.destSelector), opts.mint.toBytes()], net.poolProgram)),
    ro(alt[0]),
    ...alt.slice(1).map((k, i) => (writable.has(i + 1) ? rw(k) : ro(k))),
    ro(net.router), // the CPI target (not an account of ccip_send)
  ];
}
