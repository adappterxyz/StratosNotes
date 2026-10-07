/**
 * Cross-chain notes on a local validator (scripts/e2e.sh), with the mock
 * forwarder standing in for Chainlink CCIP (router + offramp, same PDAs and
 * call shapes as on devnet):
 *  - a Sepolia investor subscribes through `ccip_receive` (tokens + a Run call);
 *  - a subscription that lands after the book closed is refunded, not lost;
 *  - CRE autocalls the note; the remote investor's coupon and redemption
 *    accrue in the ledger like anyone's;
 *  - `withdraw_remote` sends the investor's cash back over the router's
 *    `ccip_send`, to their EVM address.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AnchorProvider, BorshCoder, EventParser, Program, Wallet } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, createAccount } from '@solana/spl-token';
import {
  ccipPda, ccipSendAccounts, compile, dec, encodeReport, encodeRun, Engine, ENGINE_IDL, ENGINE_PROGRAM_ID, EXAMPLE_PRODUCTS, instantiateProduct,
  MOCK_FORWARDER_IDL, OPEN_ROLE, parseBpmn, pda, receiveAccounts, remoteKey, reservePerUnit, SCALE, slot, CCIP,
} from '../src';
import { e2eAdmin } from './e2e-admin';

const RPC = process.env.E2E_RPC;
const conn = RPC ? new Connection(RPC, 'confirmed') : (null as unknown as Connection);
const MOCK_ID = new PublicKey((MOCK_FORWARDER_IDL as { address: string }).address);
const SEPOLIA = CCIP.sepolia.selector;
const INVESTOR_EVM = '0x8ba8251a96a503363641e5e36f5a839bdad82568';
const CASH = 1;

const provider = (kp: Keypair) => new AnchorProvider(conn, new Wallet(kp), { commitment: 'confirmed' });
const chainNow = async () => (await conn.getBlockTime(await conn.getSlot('confirmed')))!;
async function until(t: number) { while ((await chainNow()) < t) await new Promise(r => setTimeout(r, 500)); }
async function funded(sol = 20) {
  const kp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
  return kp;
}

/** Borsh Any2SVMMessage (what the CCIP offramp passes to ccip_receive). */
function any2svm(id: number, selector: bigint, senderEvm: string, data: Uint8Array, tokens: Array<{ mint: PublicKey; amount: bigint }>) {
  const out: number[] = [];
  const u32 = (v: number) => { for (let i = 0; i < 4; i++) out.push((v >>> (8 * i)) & 0xff); };
  const u64 = (v: bigint) => { for (let i = 0; i < 8; i++) out.push(Number((v >> BigInt(8 * i)) & 0xffn)); };
  const bytes = (b: Uint8Array) => { u32(b.length); out.push(...b); };
  out.push(...new Array(31).fill(0), id); // message_id
  u64(selector);
  const sender = new Uint8Array(32); sender.set(Uint8Array.from(senderEvm.slice(2).match(/../g)!.map(h => parseInt(h, 16))), 12);
  bytes(sender); // CCIP passes the EVM sender ABI-encoded (32 bytes)
  bytes(data);
  u32(tokens.length);
  for (const t of tokens) { out.push(...t.mint.toBytes()); u64(t.amount); }
  return Buffer.from(out);
}

describe.skipIf(!RPC)('cross-chain notes over CCIP (local validator, mock CCIP)', () => {
  let admin: Keypair, usdc: PublicKey, forwarderState: Keypair, mock: Program;

  beforeAll(async () => {
    admin = await e2eAdmin(conn);
    const eng = new Engine(provider(admin));
    mock = new Program(MOCK_FORWARDER_IDL, provider(admin));
    if (!(await conn.getAccountInfo(pda.config()))) await eng.send([await eng.initConfig([MOCK_ID])]);
    forwarderState = Keypair.generate();
    await mock.methods.initState().accounts({ state: forwarderState.publicKey, payer: admin.publicKey }).signers([forwarderState]).rpc();
    usdc = await createMint(conn, admin, admin.publicKey, null, 6);
  }, 120000);

  async function report(process: PublicKey, definition: PublicKey, step: number, values: bigint[]) {
    const [authority] = PublicKey.findProgramAddressSync([new TextEncoder().encode('forwarder'), forwarderState.publicKey.toBytes(), ENGINE_PROGRAM_ID.toBytes()], MOCK_ID);
    await mock.methods.forward(Buffer.alloc(0), Buffer.from(encodeReport(process.toBytes(), step, values)))
      .accounts({ state: forwarderState.publicKey, authority, receiver: ENGINE_PROGRAM_ID })
      .remainingAccounts([
        { pubkey: pda.config(), isSigner: false, isWritable: false },
        { pubkey: process, isSigner: false, isWritable: true },
        { pubkey: definition, isSigner: false, isWritable: false },
      ]).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
  }

  /** What CCIP does on devnet: tokens to the inbox's account, then ccip_receive via an allowed offramp. */
  async function ccipDeliver(id: number, process: PublicKey, definition: PublicKey, data: Uint8Array, amount: bigint) {
    const r = receiveAccounts(ENGINE_PROGRAM_ID, process, definition, usdc, CASH);
    await mintTo(conn, admin, usdc, r.accounts[4], admin, amount); // the pool minting to the token receiver
    const [authority] = PublicKey.findProgramAddressSync([new TextEncoder().encode('external_execution_config'), ENGINE_PROGRAM_ID.toBytes()], MOCK_ID);
    const [allowed] = PublicKey.findProgramAddressSync([new TextEncoder().encode('allowed_offramp'), Buffer.from(new BigUint64Array([SEPOLIA]).buffer), MOCK_ID.toBytes()], MOCK_ID);
    const sig = await mock.methods.deliver(any2svm(id, SEPOLIA, INVESTOR_EVM, data, [{ mint: usdc, amount }]))
      .accounts({ authority, thisProgram: MOCK_ID, allowedOfframp: allowed, receiver: ENGINE_PROGRAM_ID })
      .remainingAccounts(r.accounts.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: ((r.writableBitmap >> BigInt(i)) & 1n) === 1n })))
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const events = [...new EventParser(ENGINE_PROGRAM_ID, new BorshCoder(ENGINE_IDL)).parseLogs(tx!.meta!.logMessages!)];
    const ev = events.find(e => e.name.toLowerCase() === 'ccipreceived');
    if (!ev) throw new Error(`no CcipReceived event; got ${events.map(e => e.name).join(', ') || 'none'}`);
    return ev.data as { ran: boolean; used: { toString(): string }; received: { toString(): string } };
  }

  it('subscribes from Sepolia, refunds a late subscription, pays out and sends back over CCIP', async () => {
    const eng = new Engine(provider(admin));
    await eng.send([await eng.setCcip(MOCK_ID, [SEPOLIA])]);
    const [allowed] = PublicKey.findProgramAddressSync([new TextEncoder().encode('allowed_offramp'), Buffer.from(new BigUint64Array([SEPOLIA]).buffer), MOCK_ID.toBytes()], MOCK_ID);
    if (!(await conn.getAccountInfo(allowed))) await mock.methods.initAllowedOfframp(new (await import('bn.js')).default(SEPOLIA.toString())).accounts({ payer: admin.publicKey }).rpc();
    // The inbox's token account (CCIP mints inbound tokens to it) and the sender's (outbound).
    const inboxAta = (await getOrCreateAssociatedTokenAccount(conn, admin, usdc, ccipPda.inbox(ENGINE_PROGRAM_ID), true)).address;
    const senderAta = (await getOrCreateAssociatedTokenAccount(conn, admin, usdc, ccipPda.sender(ENGINE_PROGRAM_ID), true)).address;
    void inboxAta; void senderAta;

    // An FCN on ETH: issued on Solana, book open ~25 s.
    const p = EXAMPLE_PRODUCTS.fcn;
    const prod = instantiateProduct(p);
    const c = compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params });
    const definition = await eng.publish(c);
    const issuerKp = await funded();
    const issuer = new Engine(provider(issuerKp));
    const notional = 1000;
    const reserve = notional * reservePerUnit(p)!;
    await mintTo(conn, admin, usdc, (await getOrCreateAssociatedTokenAccount(conn, admin, usdc, issuerKp.publicKey)).address, admin, BigInt(reserve) * 1_000_000n);
    const id = BigInt(Date.now());
    const process = pda.process(definition, issuerKp.publicKey, id);
    const strikeAt = (await chainNow()) + 25;
    const obsAt = [1, 2, 3, 4].map(k => strikeAt + 4 * k);
    await issuer.send([
      await issuer.startProcess(definition, id, [issuerKp.publicKey, issuerKp.publicKey, OPEN_ROLE], [PublicKey.default, usdc], c.stepIndex.Start_Issuer),
      await issuer.openVault(process, CASH, usdc),
    ]);
    await issuer.send([
      await issuer.executeStep(process, definition, c.stepIndex.Task_ApproveTerms, [
        slot.text('XSCCIP000001'), slot.number(dec(notional)), slot.number(BigInt(strikeAt)), ...obsAt.map(t => slot.number(BigInt(t))), slot.number(dec(reserve)),
      ], { deposit: { asset: CASH, mint: usdc } }),
      await issuer.executeStep(process, definition, c.stepIndex.Task_Mandate, []),
    ]);

    // 1. A Sepolia investor subscribes 300 units with 300 USDC, through CCIP.
    const remote = remoteKey(0, INVESTOR_EVM);
    const ev1 = await ccipDeliver(1, process, definition, encodeRun(process, c.stepIndex.Task_Subscribe, [slot.number(dec(300))]), 300_000_000n);
    expect(ev1.ran).toBe(true);
    expect(ev1.used.toString()).toBe('300000000');
    let st = await issuer.process(process);
    expect(st.holdings.find(h => h.owner.equals(remote) && h.asset === 0)?.amount).toBe(dec(300));

    // 2. A second subscription lands after the book closed: refunded to the sender, nothing else changes.
    await until(strikeAt + 1);
    const before = await issuer.process(process);
    const ev2 = await ccipDeliver(2, process, definition, encodeRun(process, c.stepIndex.Task_Subscribe, [slot.number(dec(100))]), 100_000_000n);
    expect(ev2.ran).toBe(false);
    st = await issuer.process(process);
    expect(st.tokens).toEqual(before.tokens);
    expect(st.holdings.find(h => h.owner.equals(remote) && h.asset === 0)?.amount).toBe(dec(300));
    expect(st.holdings.find(h => h.owner.equals(remote) && h.asset === CASH)?.amount).toBe(dec(100));

    // 3. CRE: strike 2000, first observation at 104%: coupon 2% and autocall at par.
    await report(process, definition, c.stepIndex.Task_FixStrike, [dec(2000)]);
    await until(obsAt[0]);
    await report(process, definition, c.stepIndex.Task_Observe1, [dec(2080)]);
    st = await issuer.process(process);
    expect(st.status).toBe(1);
    const owed = st.holdings.find(h => h.owner.equals(remote) && h.asset === CASH)!.amount;
    expect(Number(owed) / Number(SCALE)).toBeCloseTo(100 + 300 * 1.02, 6); // refund + par + coupon

    // 4. Anyone sends it back to Sepolia: the router's ccip_send pulls exactly that from the sender PDA.
    const sink = await createAccount(conn, admin, usdc, Keypair.generate().publicKey, Keypair.generate());
    const routerAccounts = ccipSendAccounts({
      engine: ENGINE_PROGRAM_ID, mint: usdc, destSelector: SEPOLIA,
      lookupTableAddresses: [Keypair.generate().publicKey, sink], writableIndexes: [1],
      net: { ...CCIP.devnet, router: MOCK_ID },
    });
    const cranker = await funded(2);
    const crank = new Engine(provider(cranker));
    await crank.send([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      await crank.withdrawRemote(process, definition, remote, CASH, usdc, 10_000_000n, routerAccounts),
    ]);
    st = await issuer.process(process);
    expect(st.holdings.find(h => h.owner.equals(remote) && h.asset === CASH)?.amount ?? 0n).toBe(0n);
    expect(Number((await getAccount(conn, sink)).amount) / 1e6).toBeCloseTo(406, 6);
    // Nothing else can be sent for this holder now.
    await expect(crank.send([await crank.withdrawRemote(process, definition, remote, CASH, usdc, 0n, routerAccounts)])).rejects.toThrow(/NothingToSend|Nothing to send/);
    // A local holder is not remote.
    await expect(crank.send([await crank.withdrawRemote(process, definition, issuerKp.publicKey, CASH, usdc, 0n, routerAccounts)])).rejects.toThrow(/NotRemote|Not a remote/);
    void SystemProgram;
  }, 300000);
});
