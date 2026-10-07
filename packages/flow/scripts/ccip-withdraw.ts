/**
 * Send a remote (Sepolia) holder's balance home over real CCIP:
 *   npx tsx scripts/ccip-withdraw.ts <process> <holder EVM address> <asset index> <token symbol>
 *
 * withdraw_remote carries the router's ccip_send accounts (~45 in all), so it
 * goes out as a v0 transaction with two address lookup tables: the token's
 * CCIP table and the engine's own (router fixed accounts for Sepolia, engine
 * accounts), created once and recorded in deployments/devnet.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CCIP, ccipPda, ccipSendAccounts, Engine, ENGINE_PROGRAM_ID, pda, remoteKey } from '../src';

const ROOT = resolve(import.meta.dirname, '../../..');
const DEVNET = join(ROOT, 'deployments/devnet.json');
const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? join(homedir(), '.config/solana/id.json'), 'utf8'))));
const engine = new Engine(new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' }));

const [processArg, holderEvm, assetArg, symbol] = process.argv.slice(2);
const proc = new PublicKey(processArg);
const asset = Number(assetArg);
const tokens = JSON.parse(readFileSync(join(ROOT, 'deployments/solana-tokens.json'), 'utf8'));
const mint = new PublicKey(tokens[symbol].mint);
const tokenAlt = (await conn.getAddressLookupTable(new PublicKey(tokens[symbol].lookupTable))).value!;
const p = await engine.process(proc);
const holder = remoteKey(0, holderEvm);

const routerAccounts = ccipSendAccounts({ engine: ENGINE_PROGRAM_ID, mint, destSelector: CCIP.sepolia.selector, lookupTableAddresses: tokenAlt.state.addresses });

// The engine's lookup table: the router's fixed accounts for Sepolia and the engine's own.
const devnet = JSON.parse(readFileSync(DEVNET, 'utf8'));
let engineAltKey = devnet.ccip?.lookupTable ? new PublicKey(devnet.ccip.lookupTable) : null;
if (!engineAltKey) {
  const slot = await conn.getSlot('finalized');
  const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
  const addresses = [
    ...routerAccounts.slice(0, 18).map(a => a.pubkey), CCIP.devnet.router,
    ENGINE_PROGRAM_ID, pda.config(), ccipPda.config(ENGINE_PROGRAM_ID), ccipPda.sender(ENGINE_PROGRAM_ID), ccipPda.inbox(ENGINE_PROGRAM_ID), TOKEN_PROGRAM_ID,
  ];
  const extend = AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: payer.publicKey, payer: payer.publicKey, addresses });
  await engine.send([create, extend]);
  engineAltKey = key;
  devnet.ccip = { ...devnet.ccip, lookupTable: key.toBase58() };
  writeFileSync(DEVNET, JSON.stringify(devnet, null, 2) + '\n');
  await new Promise(r => setTimeout(r, 2000)); // usable from the next slot
}
const engineAlt = (await conn.getAddressLookupTable(engineAltKey)).value!;

const fee = BigInt(process.env.FEE_LAMPORTS ?? 50_000_000); // CCIP fee in SOL (unused lamports stay with the sender PDA for later sends)
const ix = await engine.withdrawRemote(proc, p.definition, holder, asset, mint, fee, routerAccounts);
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
const msg = new TransactionMessage({
  payerKey: payer.publicKey, recentBlockhash: blockhash,
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
}).compileToV0Message([engineAlt, tokenAlt]);
const tx = new VersionedTransaction(msg);
tx.sign([payer]);
console.log(`transaction ${tx.serialize().length} bytes`);
const sig = await conn.sendTransaction(tx, { maxRetries: 5 });
await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
if (t?.meta?.err) { console.log(t.meta.logMessages?.slice(-12).join('\n')); throw new Error(JSON.stringify(t.meta.err)); }
const id = t?.meta?.logMessages?.join('\n').match(/0x[0-9a-f]{64}/)?.[0];
console.log(JSON.stringify({ signature: sig, computeUnits: t?.meta?.computeUnitsConsumed, messageIdHint: id ?? null }));
