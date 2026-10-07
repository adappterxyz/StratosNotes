/**
 * StratosNotes Worker: serves the landing page (/), the marketplace app
 * (/app/, a single-page app) and a devnet test-USDC
 * faucet. The faucet key is the test mint's authority (a devnet-only key held
 * as the FAUCET_KEY secret); it mints to a token account the caller already
 * created, once per wallet per cooldown.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { runAi } from '../packages/flow/src/ai/pipeline';
import { workersAiRunner } from '../packages/flow/src/ai/runner';
import type { WorkflowDraft } from '../packages/flow/src/draft';
import { compileTemplate, definitionAddress, summarize, templateMessage, type TemplateEntry, type TemplateSummary } from '../packages/flow/src/templates';

interface Env {
  ASSETS: { fetch: (r: Request) => Promise<Response> };
  AI: { run(model: string, input: unknown): Promise<unknown> };
  FAUCET: KVNamespace;
  FAUCET_KEY: string; // JSON array secret key (devnet only)
  TEST_USDC: string;
}

const AMOUNT = 2_000n * 1_000_000n; // 2,000 test USDC (6 decimals)
const COOLDOWN_SEC = 600;
const SITE = 'https://sp.stratoslab.app';
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

const TEMPLATES_PER_HOUR = 20;
const b64bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Every template, newest first (summaries from KV metadata: one list call). */
async function listTemplates(env: Env): Promise<Response> {
  const out: TemplateSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FAUCET.list<TemplateSummary>({ prefix: 'tpl:', cursor });
    for (const k of page.keys) if (k.metadata) out.push(k.metadata);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json(out.sort((a, b) => b.createdAt - a.createdAt));
}

/**
 * Save a template. The author signs templateMessage(definition) with their
 * wallet; the Worker recompiles the workflow and accepts it only if it lands
 * on that definition address, so a template always opens what it says.
 */
async function saveTemplate(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Not allowed from this origin.' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const bucket = `tplrate:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const used = Number(await env.FAUCET.get(bucket) ?? 0);
  if (used >= TEMPLATES_PER_HOUR) return json({ error: 'Too many templates this hour; try again later.' }, 429);
  const raw = await req.text();
  if (raw.length > 300_000) return json({ error: 'The workflow is too large to save as a template.' }, 413);
  const body = JSON.parse(raw) as { entry?: Omit<TemplateEntry, 'createdAt'>; signature?: string };
  const e = body.entry;
  if (!e || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 80) return json({ error: 'Give the template a name (up to 80 characters).' }, 400);
  if (typeof e.description !== 'string' || e.description.length > 280) return json({ error: 'Keep the description under 280 characters.' }, 400);
  let author: PublicKey;
  try { author = new PublicKey(e.author); } catch { return json({ error: 'author must be a wallet address.' }, 400); }
  try {
    const key = await crypto.subtle.importKey('raw', author.toBytes(), { name: 'Ed25519' }, false, ['verify']);
    const good = await crypto.subtle.verify('Ed25519', key, b64bytes(body.signature ?? ''), new TextEncoder().encode(templateMessage(e.definition)));
    if (!good) return json({ error: 'The wallet signature does not match the author.' }, 401);
  } catch { return json({ error: 'Sign the template with your wallet.' }, 401); }
  let address: string;
  try { address = definitionAddress(compileTemplate(e)); } catch (err) { return json({ error: `The workflow does not compile: ${err instanceof Error ? err.message : String(err)}` }, 400); }
  if (address !== e.definition) return json({ error: 'The workflow does not match the definition it names.' }, 400);
  const entry: TemplateEntry = {
    definition: e.definition, name: e.name.trim(), description: e.description.trim(), author: author.toBase58(), createdAt: Math.floor(Date.now() / 1000),
    ...(e.product ? { product: e.product } : {}), ...(e.bpmnXml ? { bpmnXml: e.bpmnXml, assets: e.assets } : {}), ...(e.basis ? { basis: e.basis } : {}),
  };
  await env.FAUCET.put(bucket, String(used + 1), { expirationTtl: 7200 });
  // KV metadata holds 1 KB: the listed description is shortened to fit (the entry keeps it whole).
  const meta = summarize(entry);
  while (new TextEncoder().encode(JSON.stringify(meta)).length > 1000) meta.description = meta.description.slice(0, -10).trimEnd() + '…';
  await env.FAUCET.put(`tpl:${entry.definition}`, JSON.stringify(entry), { metadata: meta });
  return json(summarize(entry), 201);
}

const AI_PER_HOUR = 60;

/** The AI leg: term sheet -> note, edits to the open workflow, questions. Same-origin, rate-limited per IP. */
async function ai(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get('Origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Not allowed from this origin.' }, 403);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const bucket = `ai:${ip}:${Math.floor(Date.now() / 3_600_000)}`;
  const used = Number(await env.FAUCET.get(bucket) ?? 0);
  if (used >= AI_PER_HOUR) return json({ error: 'Too many AI requests this hour; try again later.' }, 429);
  await env.FAUCET.put(bucket, String(used + 1), { expirationTtl: 7200 });
  const body = await req.json().catch(() => null) as { prompt?: string; draft?: WorkflowDraft } | null;
  const prompt = (body?.prompt ?? '').trim();
  if (!prompt) return json({ error: 'Say what you want: a note from terms, a change to the workflow, or a question.' }, 400);
  if (prompt.length > 4000) return json({ error: 'Keep the request under 4,000 characters.' }, 400);
  const result = await runAi(workersAiRunner(env.AI), { prompt, today: new Date().toISOString().slice(0, 10), draft: body?.draft });
  return json(result);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/faucet' && req.method === 'POST') {
      try { return await faucet(req, env); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
    }
    if (url.pathname === '/api/ai' && req.method === 'POST') {
      try { return await ai(req, env); } catch (e) { return json({ kind: 'error', error: e instanceof Error ? e.message : String(e) }, 502); }
    }
    if (url.pathname === '/api/templates' && req.method === 'GET') return listTemplates(env);
    if (url.pathname === '/api/templates' && req.method === 'POST') {
      try { return await saveTemplate(req, env); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 400); }
    }
    const tpl = /^\/api\/templates\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname);
    if (tpl && req.method === 'GET') {
      const v = await env.FAUCET.get(`tpl:${tpl[1]}`);
      return v ? new Response(v, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } }) : json({ error: 'No template at that address.' }, 404);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    // The app used to live at the root of stratosnotes.<account>.workers.dev: send old links to its new home.
    const legacy = /^\/(note|issue|studio|portfolio)(\/|$)/.test(url.pathname);
    if (url.hostname.endsWith('.workers.dev')) {
      const path = url.pathname === '/' || legacy ? '/app' + (legacy ? url.pathname : '/') : url.pathname;
      return Response.redirect(`${SITE}${path}${url.search}`, 301);
    }
    if (legacy) return Response.redirect(`${url.origin}/app${url.pathname}${url.search}`, 301);
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
    if (url.pathname.startsWith('/app/')) {
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404) return res;
      // A client-side route (/app/note/…): serve the app shell; missing files stay 404.
      if (/\.[a-z0-9]+$/i.test(url.pathname)) return res;
      return env.ASSETS.fetch(new Request(new URL('/app/', url), req));
    }
    return env.ASSETS.fetch(req);
  },
};
