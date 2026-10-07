/**
 * Send a remote (Sepolia) holder's balance home over real CCIP, once:
 *   npx tsx scripts/ccip-withdraw.ts <process> <holder EVM address> <asset index>
 * (The payout bot, ccip-payouts.ts, does this for every remote balance.)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Engine, remoteKey } from '../src';
import { sendRemote } from './ccip-lib';

const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? join(homedir(), '.config/solana/id.json'), 'utf8'))));
const engine = new Engine(new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' }));
const [processArg, holderEvm, assetArg] = process.argv.slice(2);
const proc = new PublicKey(processArg);
const p = await engine.process(proc);
const asset = Number(assetArg);
console.log(JSON.stringify(await sendRemote({
  conn, engine, payer, process: proc, definition: p.definition, holder: remoteKey(0, holderEvm), asset, mint: p.mints[asset],
  feeLamports: BigInt(process.env.FEE_LAMPORTS ?? 50_000_000),
})));
