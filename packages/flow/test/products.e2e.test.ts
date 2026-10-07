/**
 * Every structured product, issued and run end to end on a local validator
 * (scripts/e2e.sh): the issuer self-serves the pre-trade terms and the
 * coupon reserve, two investors subscribe from the open book, the strike and
 * every observation arrive as forwarder-delivered reports (the path CRE takes
 * on devnet), and each investor's payout must equal the reference payoff.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
const CU: number[] = [];
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  compile, compileTemplate, dec, encodeReport, SEED_TEMPLATES, type TemplateSource, Engine, ENGINE_PROGRAM_ID, EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, FEEDS, instantiateProduct, MOCK_FORWARDER_IDL, OPEN_ROLE,
  parseBpmn, pda, reservePerUnit, simulateWorstOf, slot, toBase, totalPerUnit, SCALE, type ProductParams, type ProductType,
} from '../src';

const RPC = process.env.E2E_RPC;
const conn = RPC ? new Connection(RPC, 'confirmed') : (null as unknown as Connection);
const CASH = 1; // asset index of USDC in product definitions
const STRIKES: Record<string, number> = { ETH: 2000, BTC: 60000, SOL: 150 };

const provider = (kp: Keypair) => new AnchorProvider(conn, new Wallet(kp), { commitment: 'confirmed' });
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot('confirmed')))!;
async function until(t: number) { while ((await chainNow()) < t) await new Promise(r => setTimeout(r, 500)); }
async function funded() {
  const kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

/**
 * path: level at each observation, % of strike (one underlying); `paths` per
 * observation, one entry per underlying of a worst-of basket.
 * transfer: after the strike, investor 0 moves `units` of their notes to a new holder.
 */
interface Run {
  type: ProductType; path: number[] | number[][]; investors: number[]; transfer?: number; params?: ProductParams;
  /** A custom template (edited workflow): `params` is its basis; `perUnit` what investors must get; `paFee` what the paying agent must collect. */
  source?: TemplateSource; perUnit?: number; paFee?: number;
}
const seed = (part: string) => SEED_TEMPLATES.find(t => t.name.includes(part))!.source;
const ETH_BTC: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M Worst-of FCN on ETH, BTC', underlyings: [FEEDS.ETH, FEEDS.BTC] };
const RUNS: Run[] = [
  { type: 'fcn', path: [90, 104, 0, 0], investors: [600, 400] }, // autocalled at 2
  { type: 'fcn', path: [90, 95, 80, 50], investors: [700, 300] }, // knocked in: cash-settled at 0.5
  { type: 'reverse-convertible', path: [95, 80, 75, 65], investors: [500, 500] },
  { type: 'phoenix', path: [60, 65, 80, 75], investors: [250, 750], transfer: 100 }, // memory catches up at 3; part of a position changes hands
  { type: 'snowball', path: [90, 95, 99, 101], investors: [900, 100] }, // called at maturity
  { type: 'ppn', path: [130], investors: [400, 600] },
  // Worst-of: SOL misses the coupon barrier at 1; at 2 every asset is above 100%: two coupons (memory) and the call.
  { type: 'phoenix', params: EXAMPLE_WORST_OF, path: [[110, 120, 60], [105, 102, 101], [0, 0, 0], [0, 0, 0]], investors: [300, 700] },
  // Worst-of: ETH falls to 50% at maturity while BTC is fine: cash-settled on the worst performer.
  { type: 'fcn', params: ETH_BTC, path: [[95, 90], [90, 85], [80, 99], [50, 90]], investors: [600, 400] },
  // Seed templates (custom workflows). Step-down: 96% at Q3 calls (level 95%), where the stock phoenix would not.
  { type: 'phoenix', source: seed('Step-down'), params: seed('Step-down').basis, path: [80, 90, 96, 0], investors: [500, 500], perUnit: 1.075 },
  // Servicing fee: investors get the plain phoenix payoff; the paying agent collects 0.1% of 1,000 with each of the 2 coupons paid.
  { type: 'phoenix', source: seed('servicing fee'), params: seed('servicing fee').basis, path: [60, 65, 80, 75], investors: [500, 500], paFee: 2 },
];
const paramsOf = (r: Run) => r.params ?? EXAMPLE_PRODUCTS[r.type];
const rows = (r: Run) => (r.path as Array<number | number[]>).map(x => (Array.isArray(x) ? x : [x]));

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
    const sig = await mock.methods.forward(Buffer.alloc(0), Buffer.from(encodeReport(process.toBytes(), step, values)))
      .accounts({ state: forwarderState.publicKey, authority, receiver: ENGINE_PROGRAM_ID })
      .remainingAccounts([
        { pubkey: pda.config(), isSigner: false, isWritable: false },
        { pubkey: process, isSigner: false, isWritable: true },
        { pubkey: definition, isSigner: false, isWritable: false },
      ]).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    // CRE caps a Solana write at 300k compute units: record what each report costs.
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    CU.push(tx?.meta?.computeUnitsConsumed ?? 0);
  }

  it('issues, subscribes, observes and pays every product to its reference payoff', async () => {
    const defs = new Map<string, ReturnType<typeof compile>>();
    for (const r of RUNS) if (!defs.has(paramsOf(r).name)) {
      if (r.source) { defs.set(paramsOf(r).name, compileTemplate(r.source)); continue; }
      const prod = instantiateProduct(paramsOf(r));
      defs.set(paramsOf(r).name, compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }));
    }
    // Publish each product's definition once (content-addressed: shared by its runs).
    const publisher = new Engine(provider(admin));
    for (const c of defs.values()) await publisher.publish(c);

    const results = await Promise.all(RUNS.map(async (run, idx) => {
      const p: ProductParams = paramsOf(run);
      const c = defs.get(p.name)!;
      const strikes = p.underlyings.map(u => STRIKES[u.symbol]);
      const issuerKp = await funded();
      const paKp = Keypair.generate(); // the paying agent: runs only automatic steps, so it never signs
      const issuer = new Engine(provider(issuerKp));
      const definition = pda.definition(c.hash);
      const notional = run.investors.reduce((a, b) => a + b, 0);
      const reserve = Math.ceil(notional * (reservePerUnit(p) ?? (p.participationPct! / 100)));
      const mintCash = async (kp: Keypair, units: number) => {
        const ata = await getOrCreateAssociatedTokenAccount(conn, admin, usdc, kp.publicKey);
        await mintTo(conn, admin, usdc, ata.address, admin, BigInt(units) * 1_000_000n);
      };
      await mintCash(issuerKp, reserve + (run.source ? notional / 100 : 0)); // custom templates may deposit more (e.g. fees)

      // Issuer: start, pre-trade terms (size, dates, reserve deposit), mandate.
      const id = BigInt(Date.now()) * 10n + BigInt(idx);
      const process = pda.process(definition, issuerKp.publicKey, id);
      const t0 = await chainNow();
      const strikeAt = t0 + 30;
      const obsAt = Array.from({ length: p.observations }, (_, k) => strikeAt + 5 * (k + 1));
      await issuer.send([
        await issuer.startProcess(definition, id, [issuerKp.publicKey, paKp.publicKey, OPEN_ROLE], [PublicKey.default, usdc], c.stepIndex.Start_Issuer),
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
      await report(process, definition, c.stepIndex.Task_FixStrike, strikes.map(s => dec(s)));
      // Secondary transfer, in part: later coupons and the redemption follow the units.
      if (run.transfer) {
        const buyer = await funded();
        await getOrCreateAssociatedTokenAccount(conn, admin, usdc, buyer.publicKey);
        const seller = investors[0];
        await expect(seller.e.send([await seller.e.transferUnits(process, definition, CASH, buyer.publicKey, dec(1))])).rejects.toThrow(/NotTransferable|transferred/);
        await expect(seller.e.send([await seller.e.transferUnits(process, definition, 0, buyer.publicKey, dec(seller.units + 1))])).rejects.toThrow(/InsufficientBalance|Insufficient/);
        await seller.e.send([await seller.e.transferUnits(process, definition, 0, buyer.publicKey, dec(run.transfer))]);
        investors.push({ kp: buyer, e: new Engine(provider(buyer)), units: run.transfer });
        seller.units -= run.transfer;
      }
      for (let k = 1; k <= p.observations; k++) {
        if ((await issuer.process(process)).status !== 0) break; // autocalled
        await until(obsAt[k - 1]);
        await report(process, definition, c.stepIndex[`Task_Observe${k}`], rows(run)[k - 1].map((x, i) => dec(strikes[i] * x / 100)));
      }
      const final = await issuer.process(process);

      // Investors withdraw what they were paid, as SPL USDC.
      const ref = simulateWorstOf(p, strikes, rows(run).map(r => r.map((x, i) => strikes[i] * x / 100)));
      const paid = await Promise.all(investors.map(async inv => {
        const owed = final.holdings.find(h => h.owner.equals(inv.kp.publicKey) && h.asset === CASH)?.amount ?? 0n;
        const base = toBase(owed, 6);
        if (base > 0n) await inv.e.send([await inv.e.withdraw(process, definition, CASH, usdc, base)]);
        const bal = (await getAccount(conn, getAssociatedTokenAddressSync(usdc, inv.kp.publicKey))).amount;
        return { units: inv.units, owed, wallet: bal };
      }));
      const paCash = Number(final.holdings.find(h => h.owner.equals(paKp.publicKey) && h.asset === CASH)?.amount ?? 0n) / Number(SCALE);
      return { run, final, ref, paid, paCash };
    }));

    console.log(`report compute units: max ${Math.max(...CU)}, mean ${Math.round(CU.reduce((a, b) => a + b, 0) / CU.length)} over ${CU.length} reports`);
    expect(Math.max(...CU)).toBeLessThan(300_000); // CRE's cap for a Solana write
    for (const { run, final, ref, paid, paCash } of results) {
      expect(final.status, `${run.type} ${run.path} completed`).toBe(1);
      expect(paCash, `${paramsOf(run).name}: paying agent fees`).toBeCloseTo(run.paFee ?? 0, 6);
      for (const x of paid) {
        const expected = x.units * (run.perUnit ?? totalPerUnit(ref));
        expect(Number(x.owed) / Number(SCALE), `${run.type} ${run.path}: ${x.units} units`).toBeCloseTo(expected, 6);
        expect(Number(x.wallet) / 1e6, `${run.type}: withdrawn as USDC`).toBeCloseTo(expected, 5);
      }
    }
  }, 600000);
});
