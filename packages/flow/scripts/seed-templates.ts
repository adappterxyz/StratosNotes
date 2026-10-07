/**
 * Seed the template library: publish each workflow's definition on devnet,
 * sign it with the payer key (the author) and register it with the app's
 * Worker, which recompiles it and checks the definition address.
 *
 *   npx tsx scripts/seed-templates.ts   (SITE=https://sp.stratoslab.app; DRY=1 compiles only; ONLY=<name part> for one)
 *
 * The templates themselves are in src/products/library.ts.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import { compileTemplate, definitionAddress, Engine, SEED_TEMPLATES as TEMPLATES, templateMessage } from '../src';

const SITE = process.env.SITE ?? 'https://sp.stratoslab.app';
const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET ?? join(homedir(), '.config/solana/id.json'), 'utf8'))));
const engine = new Engine(new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' }));

for (const t of TEMPLATES.filter(x => !process.env.ONLY || x.name.includes(process.env.ONLY))) {
  const c = compileTemplate(t.source);
  const definition = definitionAddress(c);
  if (process.env.DRY) { console.log('ok', t.name, definition, `${c.bytes.length} bytes`, t.description.length); continue; }
  // Public devnet RPC rate-limits bursts of writes: publish() resumes where it stopped, so retry.
  for (let attempt = 1; ; attempt++) {
    try { await engine.publish(c); break; }
    catch (e) { if (attempt >= 6) throw e; console.log(`  retry ${attempt}: ${String(e).slice(0, 80)}`); await new Promise(r => setTimeout(r, 8000 * attempt)); }
  }
  const sig = ed25519.sign(new TextEncoder().encode(templateMessage(definition)), payer.secretKey.slice(0, 32));
  const r = await fetch(`${SITE}/api/templates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE },
    body: JSON.stringify({ entry: { ...t.source, definition, name: t.name, description: t.description, author: payer.publicKey.toBase58() }, signature: Buffer.from(sig).toString('base64') }),
  });
  console.log(r.status, t.name, definition, r.ok ? '' : await r.text());
}
