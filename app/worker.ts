/**
 * StratosNotes Worker: serves the marketplace app and a devnet test-USDC
 * faucet. The faucet key is the test mint's authority (a devnet-only key held
 * as the FAUCET_KEY secret); it mints to a token account the caller already
 * created, once per wallet per cooldown.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

interface Env {
  ASSETS: { fetch: (r: Request) => Promise<Response> };
  FAUCET: KVNamespace;
  FAUCET_KEY: string; // JSON array secret key (devnet only)
  TEST_USDC: string;
}

const AMOUNT = 2_000n * 1_000_000n; // 2,000 test USDC (6 decimals)
const COOLDOWN_SEC = 600;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Sign a mint of test USDC to the caller's token account. Public devnet RPCs
 * refuse Workers' IPs, so the Worker never calls Solana: the app sends a
 * recent blockhash, gets the signed transaction back, and submits it itself.
 */
async function faucet(req: Request, env: Env): Promise<Response> {
  const body = await req.json().catch(() => null) as { owner?: string; blockhash?: string } | null;
  let owner: PublicKey;
  try { owner = new PublicKey(body?.owner ?? ''); } catch { return json({ error: 'Send { "owner": "<wallet address>", "blockhash": "<recent blockhash>" }.' }, 400); }
  if (!body?.blockhash || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.blockhash)) return json({ error: 'A recent blockhash is required.' }, 400);
  const key = `faucet:${owner.toBase58()}`;
  const last = Number(await env.FAUCET.get(key) ?? 0);
  const now = Math.floor(Date.now() / 1000);
  if (now - last < COOLDOWN_SEC) return json({ error: `Already sent; try again in ${Math.ceil((COOLDOWN_SEC - (now - last)) / 60)} min.` }, 429);
  const mint = new PublicKey(env.TEST_USDC);
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.FAUCET_KEY)));
  const tx = new Transaction().add(createMintToInstruction(mint, getAssociatedTokenAddressSync(mint, owner), signer.publicKey, AMOUNT));
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = body.blockhash;
  tx.sign(signer);
  await env.FAUCET.put(key, String(now), { expirationTtl: COOLDOWN_SEC * 2 });
  return json({ transaction: btoa(String.fromCharCode(...tx.serialize())), amount: '2000' });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/faucet' && req.method === 'POST') {
      try { return await faucet(req, env); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  },
};
