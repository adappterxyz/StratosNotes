import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { sha256 } from '@noble/hashes/sha256';

/** The engine config's admin in local e2e runs: one key for every test file on the same validator. */
export async function e2eAdmin(conn: Connection): Promise<Keypair> {
  const kp = Keypair.fromSeed(sha256(new TextEncoder().encode('stratosnotes-e2e-admin')));
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}
