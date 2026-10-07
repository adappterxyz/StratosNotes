/**
 * Devnet setup and a demo issuance.
 *   npx tsx scripts/devnet.ts init            engine config (accepted forwarders) + test USDC mint
 *   npx tsx scripts/devnet.ts issue [type]    a short-dated demo note, two investors subscribed
 * Uses the Solana CLI wallet (ANCHOR_WALLET or ~/.config/solana/id.json) to sign; never prints keys.
 */
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CCIP, ccipPda, ENGINE_PROGRAM_ID, compile, dec, Engine, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, instantiateProduct, OPEN_ROLE, parseBpmn, pda, reservePerUnit, slot, type ProductParams, type ProductType } from '../src';

const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = join(ROOT, 'deployments/devnet.json');
const KEYS = join(ROOT, '.demo-keys');
const RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
// Chainlink keystone forwarders on devnet: CRE simulator (mock) and the staging DON.
const FORWARDERS = ['7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK', 'CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5'];

const conn = new Connection(RPC, 'confirmed');
const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
const payer = loadKp(process.env.ANCHOR_WALLET ?? join(homedir(), '.config/solana/id.json'));
const engineFor = (kp: Keypair) => new Engine(new AnchorProvider(conn, new Wallet(kp), { commitment: 'confirmed' }));
const state = (): Record<string, any> => existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const save = (s: Record<string, any>) => writeFileSync(OUT, JSON.stringify(s, null, 2) + '\n');

function demoKey(name: string): Keypair {
  mkdirSync(KEYS, { recursive: true });
  const p = join(KEYS, `${name}.json`);
  if (!existsSync(p)) writeFileSync(p, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 });
  return loadKp(p);
}

async function fund(to: PublicKey, sol: number) {
  if ((await conn.getBalance(to)) >= sol * LAMPORTS_PER_SOL / 2) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  await engineFor(payer).provider.sendAndConfirm(tx);
}

async function init() {
  const s = state();
  const eng = engineFor(payer);
  if (!(await conn.getAccountInfo(pda.config()))) {
    await eng.send([await eng.initConfig(FORWARDERS.map(f => new PublicKey(f)))]);
    console.log('engine config initialised; accepted forwarders:', FORWARDERS.join(', '));
  }
  if (!s.testUsdc) {
    s.testUsdc = (await createMint(conn, payer, payer.publicKey, null, 6)).toBase58();
    console.log('test USDC mint:', s.testUsdc);
  }
  save({ ...s, engine: eng.program.programId.toBase58(), config: pda.config().toBase58(), forwarders: FORWARDERS });
}

async function issue(type: ProductType | 'worst-of') {
  const s = state();
  const usdc = new PublicKey(s.testUsdc);
  const p: ProductParams = { ...(type === 'worst-of' ? EXAMPLE_WORST_OF : EXAMPLE_PRODUCTS[type]) };
  // Overrides for live tests: PHYSICAL=1 (physical delivery), KI=<% of strike>, OBS=<observations>.
  if (process.env.PHYSICAL) p.settlement = 'physical';
  if (process.env.KI) p.knockInBarrierPct = Number(process.env.KI);
  if (process.env.OBS) p.observations = Number(process.env.OBS);
  if (process.env.PHYSICAL || process.env.KI || process.env.OBS) p.name = `${p.name} (${p.settlement === 'physical' ? 'physical' : 'cash'}, KI ${p.knockInBarrierPct}%)`;
  const prod = instantiateProduct(p);
  const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
  const issuer = engineFor(payer);
  const definition = await issuer.publish(c);
  const units = [600, 400];
  // EXTRA_UNITS: left unsold at issue, e.g. for an investor subscribing from Sepolia over CCIP.
  const notional = units.reduce((a, b) => a + b, 0) + Number(process.env.EXTRA_UNITS ?? 0);
  const reserve = Math.ceil(notional * (reservePerUnit(p) ?? (p.participationPct ?? 0) / 100));
  // The faucet key holds the test mint's authority once it has been handed over.
  const faucetPath = join(KEYS, 'faucet.json');
  const minter = existsSync(faucetPath) ? loadKp(faucetPath) : payer;
  const cash = async (owner: PublicKey, n: number) => {
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, usdc, owner);
    // Test USDC is a CCIP cross-chain token: its mint authority is a 1-of-2 SPL multisig
    // (CCIP pool signer, faucet key); the faucet key mints as a member.
    const multisig = (() => { try { return new PublicKey(JSON.parse(readFileSync(join(ROOT, 'deployments/solana-tokens.json'), 'utf8')).tUSD.multisig); } catch { return null; } })();
    if (multisig) await mintTo(conn, payer, usdc, ata.address, multisig, BigInt(n) * 1_000_000n, [minter]);
    else await mintTo(conn, payer, usdc, ata.address, minter, BigInt(n) * 1_000_000n);
  };
  await cash(payer.publicKey, reserve);

  const now = Math.floor(Date.now() / 1000);
  const strikeAt = now + Number(process.env.STRIKE_IN ?? 240);
  const every = Number(process.env.OBS_EVERY ?? 120);
  const obs = Array.from({ length: p.observations }, (_, k) => strikeAt + every * (k + 1));
  const id = BigInt(now);
  const proc = pda.process(definition, payer.publicKey, id);
  // One mint per token asset: test USDC for cash, the cross-chain token for each deliverable underlying.
  const tokens = JSON.parse(readFileSync(join(ROOT, 'deployments/solana-tokens.json'), 'utf8')) as Record<string, { mint: string; decimals: number; multisig: string }>;
  const mints = prod.assets.map(a => (a.kind === 'cash' ? (a.token && a.token !== 'tUSD' ? new PublicKey(tokens[a.token].mint) : usdc) : PublicKey.default));
  await issuer.send([
    await issuer.startProcess(definition, id, [payer.publicKey, payer.publicKey, OPEN_ROLE], mints, c.stepIndex.Start_Issuer),
    ...await Promise.all(mints.map((m, i) => (m.equals(PublicKey.default) ? null : issuer.openVault(proc, i, m))).filter(Boolean) as Promise<import('@solana/web3.js').TransactionInstruction>[]),
  ]);
  await issuer.send([
    await issuer.executeStep(proc, definition, c.stepIndex.Task_ApproveTerms, [
      slot.text(`XSDEMO${String(now).slice(-6)}`), slot.number(dec(notional)), slot.number(BigInt(strikeAt)),
      ...obs.map(t => slot.number(BigInt(t))), slot.number(dec(reserve)),
    ], { deposit: { asset: 1, mint: usdc } }),
  ]);
  // Physical delivery: the issuer (a member of each token's mint multisig) mints and deposits a reserve.
  for (const [i, a] of prod.assets.entries()) {
    if (!a.token || a.token === 'tUSD' || a.kind !== 'cash') continue;
    const sym = a.id.slice(2); // d_ETH -> ETH
    const t = tokens[a.token];
    const units = Number(process.env[`RESERVE_${sym}`] ?? notional / 1000); // e.g. 1,000 units / ~2,600 ETH ≈ 0.4 tETH
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mints[i], payer.publicKey);
    await mintTo(conn, payer, mints[i], ata.address, new PublicKey(t.multisig), BigInt(Math.ceil(units * 10 ** t.decimals)), [payer]);
    await issuer.send([await issuer.executeStep(proc, definition, c.stepIndex[`Task_DeliveryReserve_${sym}`], [slot.number(dec(units))], { deposit: { asset: i, mint: mints[i] } })]);
  }
  await issuer.send([await issuer.executeStep(proc, definition, c.stepIndex.Task_Mandate, [])]);
  for (const [i, u] of units.entries()) {
    const kp = demoKey(`investor${i + 1}`);
    await fund(kp.publicKey, 0.02);
    await cash(kp.publicKey, u);
    const e = engineFor(kp);
    await e.send([await e.executeStep(proc, definition, c.stepIndex.Task_Subscribe, [slot.number(dec(u))], { deposit: { asset: 1, mint: usdc } })]);
  }
  const issues = s.issues ?? [];
  issues.push({ type, name: p.name, process: proc.toBase58(), definition: definition.toBase58(), strikeAt, observations: obs, investors: units });
  save({ ...s, issues });
  console.log(JSON.stringify({ process: proc.toBase58(), definition: definition.toBase58(), strikeAt: new Date(strikeAt * 1000).toISOString(), observations: obs.map(t => new Date(t * 1000).toISOString()) }, null, 2));
}

/** A demo investor moves note units to another demo wallet (in whole or in part). */
async function transfer(processAddr: string, from: string, to: string, units: number) {
  const proc = new PublicKey(processAddr);
  const seller = demoKey(from), buyer = demoKey(to);
  await fund(seller.publicKey, 0.01);
  const e = engineFor(seller);
  const p = await e.process(proc);
  await e.send([await e.transferUnits(proc, p.definition, 0, buyer.publicKey, dec(units))]);
  console.log(`${from} -> ${to}: ${units} units (${buyer.publicKey.toBase58()})`);
}

/**
 * CCIP: point the engine at Chainlink's devnet router with Sepolia as the
 * accepted chain, and create the engine's inbox (inbound tokens) and sender
 * (outbound) token accounts for every cross-chain token.
 */
async function ccip() {
  const s = state();
  const tokens = JSON.parse(readFileSync(join(ROOT, 'deployments/solana-tokens.json'), 'utf8')) as Record<string, { mint: string }>;
  const e = engineFor(payer);
  await e.send([await e.setCcip(CCIP.devnet.router, [CCIP.sepolia.selector])]);
  // The outbox of payouts CRE locks for holders on other chains.
  const outbox = PublicKey.findProgramAddressSync([new TextEncoder().encode('outbox')], ENGINE_PROGRAM_ID)[0];
  if (!(await conn.getAccountInfo(outbox))) await e.send([await e.initOutbox()]);
  const inbox = ccipPda.inbox(ENGINE_PROGRAM_ID), sender = ccipPda.sender(ENGINE_PROGRAM_ID);
  const accounts: Record<string, { inbox: string; sender: string }> = {};
  for (const [sym, t] of Object.entries(tokens)) {
    const mint = new PublicKey(t.mint);
    accounts[sym] = {
      inbox: (await getOrCreateAssociatedTokenAccount(conn, payer, mint, inbox, true)).address.toBase58(),
      sender: (await getOrCreateAssociatedTokenAccount(conn, payer, mint, sender, true)).address.toBase58(),
    };
  }
  s.ccip = { ...s.ccip, outbox: outbox.toBase58(), router: CCIP.devnet.router.toBase58(), chains: { sepolia: CCIP.sepolia.selector.toString() }, inbox: inbox.toBase58(), sender: sender.toBase58(), tokenAccounts: accounts };
  save(s);
  console.log(JSON.stringify(s.ccip, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'init') await init();
else if (cmd === 'issue') await issue((arg as ProductType | 'worst-of') ?? 'fcn');
else if (cmd === 'ccip') await ccip();
else if (cmd === 'transfer') await transfer(arg, process.argv[4], process.argv[5], Number(process.argv[6]));
else console.log('usage: devnet.ts init | issue [fcn|reverse-convertible|phoenix|snowball|ppn]');
