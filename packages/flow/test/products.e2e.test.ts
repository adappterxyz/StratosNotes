/**
 * Every structured product, issued and run end to end on a local validator
 * (scripts/e2e.sh): the issuer self-serves the pre-trade terms and the
 * coupon reserve, two investors subscribe from the open book, the strike and
 * every observation arrive as forwarder-delivered reports (the path CRE takes
 * on devnet), and each investor's payout must equal the reference payoff.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  compile, dec, encodeReport, Engine, ENGINE_PROGRAM_ID, EXAMPLE_PRODUCTS, instantiateProduct, MOCK_FORWARDER_IDL, OPEN_ROLE,
  parseBpmn, pda, reservePerUnit, simulatePayoff, slot, toBase, totalPerUnit, SCALE, type ProductParams, type ProductType,
} from '../src';

const RPC = process.env.E2E_RPC;
const conn = RPC ? new Connection(RPC, 'confirmed') : (null as unknown as Connection);
const CASH = 1; // asset index of USDC in product definitions
const STRIKE = 2000;

const provider = (kp: Keypair) => new AnchorProvider(conn, new Wallet(kp), { commitment: 'confirmed' });
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot('confirmed')))!;
async function until(t: number) { while ((await chainNow()) < t) await new Promise(r => setTimeout(r, 500)); }
async function funded() {
  const kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

interface Run { type: ProductType; path: number[]; investors: number[] }
const RUNS: Run[] = [
  { type: 'fcn', path: [90, 104, 0, 0], investors: [600, 400] }, // autocalled at 2
  { type: 'fcn', path: [90, 95, 80, 50], investors: [700, 300] }, // knocked in: cash-settled at 0.5
  { type: 'reverse-convertible', path: [95, 80, 75, 65], investors: [500, 500] },
  { type: 'phoenix', path: [60, 65, 80, 75], investors: [250, 750] }, // memory catches up at 3
  { type: 'snowball', path: [90, 95, 99, 101], investors: [900, 100] }, // called at maturity
  { type: 'ppn', path: [130], investors: [400, 600] },
];

describe.skipIf(!RPC)('structured products on Solana (local validator)', () => {
  let admin: Keypair, usdc: PublicKey, forwarderState: Keypair;
  const MOCK_ID = new PublicKey((MOCK_FORWARDER_IDL as { address: string }).address);

  beforeAll(async () => {
    admin = await funded();
    const eng = new Engine(provider(admin));
    await eng.send([await eng.initConfig([MOCK_ID])]);
    forwarderState = Keypair.generate();
    const mock = new Program(MOCK_FORWARDER_IDL, provider(admin));
    await mock.methods.initState().accounts({ state: forwarderState.publicKey, payer: admin.publicKey }).signers([forwarderState]).rpc();
    usdc = await createMint(conn, admin, admin.publicKey, null, 6);
  }, 120000);

  /** What CRE does on devnet: a report through the forwarder into on_report. */
  async function report(process: PublicKey, definition: PublicKey, step: number, values: bigint[]) {
    const mock = new Program(MOCK_FORWARDER_IDL, provider(admin));
    const [authority] = PublicKey.findProgramAddressSync([new TextEncoder().encode('forwarder'), forwarderState.publicKey.toBytes(), ENGINE_PROGRAM_ID.toBytes()], MOCK_ID);
    await mock.methods.forward(Buffer.alloc(0), Buffer.from(encodeReport(process.toBytes(), step, values)))
      .accounts({ state: forwarderState.publicKey, authority, receiver: ENGINE_PROGRAM_ID })
      .remainingAccounts([
        { pubkey: pda.config(), isSigner: false, isWritable: false },
        { pubkey: process, isSigner: false, isWritable: true },
        { pubkey: definition, isSigner: false, isWritable: false },
      ]).rpc();
  }

  it('issues, subscribes, observes and pays every product to its reference payoff', async () => {
    const defs = new Map<ProductType, ReturnType<typeof compile>>();
    for (const r of RUNS) if (!defs.has(r.type)) {
      const prod = instantiateProduct(EXAMPLE_PRODUCTS[r.type]);
      defs.set(r.type, compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }));
    }
    // Publish each product's definition once (content-addressed: shared by its runs).
    const publisher = new Engine(provider(admin));
    for (const c of defs.values()) await publisher.publish(c);

    const results = await Promise.all(RUNS.map(async (run, idx) => {
      const p: ProductParams = EXAMPLE_PRODUCTS[run.type];
      const c = defs.get(run.type)!;
      const issuerKp = await funded();
      const issuer = new Engine(provider(issuerKp));
      const definition = pda.definition(c.hash);
      const notional = run.investors.reduce((a, b) => a + b, 0);
      const reserve = Math.ceil(notional * (reservePerUnit(p) ?? (p.participationPct! / 100)));
      const mintCash = async (kp: Keypair, units: number) => {
        const ata = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, kp.publicKey);
        await mintTo(conn, admin, usdc, ata.address, admin, BigInt(units) * 1_000_000n);
      };
      await mintCash(issuerKp, reserve);

      // Issuer: start, pre-trade terms (size, dates, reserve deposit), mandate.
      const id = BigInt(Date.now()) * 10n + BigInt(idx);
      const process = pda.process(definition, issuerKp.publicKey, id);
      const t0 = await chainNow();
      const strikeAt = t0 + 30;
      const obsAt = Array.from({ length: p.observations }, (_, k) => strikeAt + 5 * (k + 1));
      await issuer.send([
        await issuer.startProcess(definition, id, [issuerKp.publicKey, issuerKp.publicKey, OPEN_ROLE], [PublicKey.default, usdc], c.stepIndex.Start_Issuer),
        await issuer.openVault(process, CASH, usdc),
      ]);
      await issuer.send([
        await issuer.executeStep(process, definition, c.stepIndex.Task_ApproveTerms, [
          slot.text(`XS${String(idx).padStart(10, '0')}`), slot.number(dec(notional)), slot.number(BigInt(strikeAt)),
          ...obsAt.map(t => slot.number(BigInt(t))), slot.number(dec(reserve)),
        ], { deposit: { asset: CASH, mint: usdc } }),
        await issuer.executeStep(process, definition, c.stepIndex.Task_Mandate, []),
      ]);

      // Marketplace: two investors subscribe from the open book.
      const investors = await Promise.all(run.investors.map(async units => {
        const kp = await funded();
        await mintCash(kp, Math.ceil(units * p.issuePricePct / 100));
        const e = new Engine(provider(kp));
        await e.send([await e.executeStep(process, definition, c.stepIndex.Task_Subscribe, [slot.number(dec(units))], { deposit: { asset: CASH, mint: usdc } })]);
        return { kp, e, units };
      }));

      // CRE's job: the strike on the strike date, then each observation on its date.
      await until(strikeAt);
      await report(process, definition, c.stepIndex.Task_FixStrike, [dec(STRIKE)]);
      for (let k = 1; k <= p.observations; k++) {
        if ((await issuer.process(process)).status !== 0) break; // autocalled
        await until(obsAt[k - 1]);
        await report(process, definition, c.stepIndex[`Task_Observe${k}`], [dec(STRIKE * run.path[k - 1] / 100)]);
      }
      const final = await issuer.process(process);

      // Investors withdraw what they were paid, as SPL USDC.
      const ref = simulatePayoff(p, STRIKE, run.path.map(x => STRIKE * x / 100));
      const paid = await Promise.all(investors.map(async inv => {
        const owed = final.holdings.find(h => h.owner.equals(inv.kp.publicKey) && h.asset === CASH)?.amount ?? 0n;
        const base = toBase(owed, 6);
        if (base > 0n) await inv.e.send([await inv.e.withdraw(process, definition, CASH, usdc, base)]);
        const bal = (await getAccount(conn, getAssociatedTokenAddressSync(usdc, inv.kp.publicKey))).amount;
        return { units: inv.units, owed, wallet: bal };
      }));
      return { run, final, ref, paid };
    }));

    for (const { run, final, ref, paid } of results) {
      expect(final.status, `${run.type} ${run.path} completed`).toBe(1);
      for (const x of paid) {
        const expected = x.units * totalPerUnit(ref);
        expect(Number(x.owed) / Number(SCALE), `${run.type} ${run.path}: ${x.units} units`).toBeCloseTo(expected, 6);
        expect(Number(x.wallet) / 1e6, `${run.type}: withdrawn as USDC`).toBeCloseTo(expected, 5);
      }
    }
  }, 600000);
});
