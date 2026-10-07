/**
 * The CCIP payout relay: delivers the payouts Chainlink CRE has decided.
 *
 * CRE (cre/notes-keeper) is the paying agent for holders on other chains: each
 * run, for every Sepolia holder with a token balance (a coupon, a redemption,
 * delivered tokens, a refund), it writes a DON-signed payout report that has
 * the engine lock the amount for CCIP and record it in the outbox. CRE cannot
 * submit the CCIP send itself (the router's ~40 accounts need address lookup
 * tables, which CRE's Solana writes do not support), so this relay delivers
 * each outbox entry with flush_outbox. It decides nothing: the engine sends
 * exactly what CRE recorded, to the recorded address. Anyone can run one.
 *
 *   npx tsx scripts/ccip-payouts.ts          (loop; ONCE=1 for a single pass)
 *   pm2 start "npx tsx scripts/ccip-payouts.ts" --name stratosnotes-ccip-payouts --cwd packages/flow
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ccipPda, Engine, ENGINE_PROGRAM_ID, remoteOf } from '../src';
import { flushPayout, symbolOfMint, TOKENS } from './ccip-lib';

const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? join(homedir(), '.config/solana/id.json'), 'utf8'))));
const engine = new Engine(new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' }));
const INTERVAL = Number(process.env.INTERVAL ?? 30) * 1000;
const LOW = 0.05 * LAMPORTS_PER_SOL, TOP_UP = 0.2 * LAMPORTS_PER_SOL; // the sender PDA pays CCIP fees in SOL
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);

async function pass() {
  // Deliver one at a time: flushing swaps the last entry into the delivered slot.
  for (let guard = 0; guard < 32; guard++) {
    const outbox = await engine.outbox();
    const index = outbox.findIndex(o => symbolOfMint(o.mint));
    if (index < 0) return;
    const po = outbox[index];
    const sender = await conn.getBalance(ccipPda.sender(ENGINE_PROGRAM_ID));
    const sym = symbolOfMint(po.mint)!;
    const units = Number(po.amount) / 10 ** TOKENS[sym].decimals;
    try {
      const out = await flushPayout({ conn, engine, payer, index, mint: po.mint, feeLamports: BigInt(sender < LOW ? TOP_UP : 0) });
      log(`${po.process.toBase58()} -> ${remoteOf(po.holder)?.address}: ${units} ${sym} sent over CCIP (${out.signature})`);
    } catch (e) {
      log(`${po.process.toBase58()} -> ${remoteOf(po.holder)?.address}: delivery failed, will retry: ${String(e).slice(0, 300)}`);
      return;
    }
  }
}

for (;;) {
  try { await pass(); } catch (e) { log(`pass failed: ${String(e).slice(0, 200)}`); }
  if (process.env.ONCE) break;
  await new Promise(r => setTimeout(r, INTERVAL));
}
