/**
 * Sending a Sepolia (remote) holder's balance home over CCIP from a server
 * key: withdraw_remote as a v0 transaction with the token's CCIP lookup table
 * and the engine's own (created once, recorded in deployments/devnet.json).
 * Used by ccip-withdraw.ts (one send) and ccip-payouts.ts (the relay that
 * delivers the payouts CRE locked in the outbox).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CCIP, ccipPda, ccipSendAccounts, Engine, ENGINE_PROGRAM_ID, pda } from '../src';

export const ROOT = resolve(import.meta.dirname, '../../..');
const DEVNET = join(ROOT, 'deployments/devnet.json');
export const TOKENS = JSON.parse(readFileSync(join(ROOT, 'deployments/solana-tokens.json'), 'utf8')) as Record<string, { mint: string; decimals: number; lookupTable: string }>;
export const symbolOfMint = (mint: PublicKey) => Object.entries(TOKENS).find(([, t]) => t.mint === mint.toBase58())?.[0] ?? null;

/** The engine's lookup table (router fixed accounts for Sepolia + engine accounts), created on first use. */
async function engineAlt(conn: Connection, engine: Engine, payer: Keypair, routerFixed: PublicKey[]) {
  const devnet = JSON.parse(readFileSync(DEVNET, 'utf8'));
  let key = devnet.ccip?.lookupTable ? new PublicKey(devnet.ccip.lookupTable) : null;
  if (!key) {
    const slot = await conn.getSlot('finalized');
    const [create, k] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
    const addresses = [
      ...routerFixed, CCIP.devnet.router,
      ENGINE_PROGRAM_ID, pda.config(), ccipPda.config(ENGINE_PROGRAM_ID), ccipPda.sender(ENGINE_PROGRAM_ID), ccipPda.inbox(ENGINE_PROGRAM_ID), TOKEN_PROGRAM_ID,
    ];
    await engine.send([create, AddressLookupTableProgram.extendLookupTable({ lookupTable: k, authority: payer.publicKey, payer: payer.publicKey, addresses })]);
    key = k;
    devnet.ccip = { ...devnet.ccip, lookupTable: k.toBase58() };
    writeFileSync(DEVNET, JSON.stringify(devnet, null, 2) + '\n');
    await new Promise(r => setTimeout(r, 2000)); // usable from the next slot
  }
  return (await conn.getAddressLookupTable(key)).value!;
}

/**
 * Send `holder`'s whole balance of `asset` (a token asset of `process`) to its
 * chain. `feeLamports` tops up the engine's sender PDA, which pays CCIP fees in SOL.
 */
export async function sendRemote(opts: { conn: Connection; engine: Engine; payer: Keypair; process: PublicKey; definition: PublicKey; holder: PublicKey; asset: number; mint: PublicKey; feeLamports: bigint }) {
  const { conn, engine, payer } = opts;
  const symbol = symbolOfMint(opts.mint);
  if (!symbol) throw new Error(`${opts.mint.toBase58()} is not a cross-chain token`);
  const tokenAlt = (await conn.getAddressLookupTable(new PublicKey(TOKENS[symbol].lookupTable))).value!;
  const routerAccounts = ccipSendAccounts({ engine: ENGINE_PROGRAM_ID, mint: opts.mint, destSelector: CCIP.sepolia.selector, lookupTableAddresses: tokenAlt.state.addresses });
  const alt = await engineAlt(conn, engine, payer, routerAccounts.slice(0, 18).map(a => a.pubkey));
  const ix = await engine.withdrawRemote(opts.process, opts.definition, opts.holder, opts.asset, opts.mint, opts.feeLamports, routerAccounts);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message([alt, tokenAlt]));
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (t?.meta?.err) throw new Error(`${JSON.stringify(t.meta.err)}: ${t.meta.logMessages?.slice(-6).join(' | ')}`);
  return { signature: sig, computeUnits: t?.meta?.computeUnitsConsumed, symbol };
}

/** Deliver outbox payout `index` (locked by CRE) over CCIP; anyone may do this. */
export async function flushPayout(opts: { conn: Connection; engine: Engine; payer: Keypair; index: number; mint: PublicKey; feeLamports: bigint }) {
  const { conn, engine, payer } = opts;
  const symbol = symbolOfMint(opts.mint);
  if (!symbol) throw new Error(`${opts.mint.toBase58()} is not a cross-chain token`);
  const tokenAlt = (await conn.getAddressLookupTable(new PublicKey(TOKENS[symbol].lookupTable))).value!;
  const routerAccounts = ccipSendAccounts({ engine: ENGINE_PROGRAM_ID, mint: opts.mint, destSelector: CCIP.sepolia.selector, lookupTableAddresses: tokenAlt.state.addresses });
  const alt = await engineAlt(conn, engine, payer, routerAccounts.slice(0, 18).map(a => a.pubkey));
  const ix = await engine.flushOutbox(opts.index, opts.mint, opts.feeLamports, routerAccounts);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message([alt, tokenAlt]));
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (t?.meta?.err) throw new Error(`${JSON.stringify(t.meta.err)}: ${t.meta.logMessages?.slice(-6).join(' | ')}`);
  return { signature: sig, computeUnits: t?.meta?.computeUnitsConsumed, symbol };
}
