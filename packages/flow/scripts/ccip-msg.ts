/**
 * The fields of an EVM -> Solana CCIP message to the engine, for `cast`:
 *   npx tsx scripts/ccip-msg.ts run <process> <stepId> <units> <asset index> <mint>
 *   npx tsx scripts/ccip-msg.ts deposit <process> <role index> <asset index> <mint>
 * Prints JSON: receiver (bytes32), data (hex), extraArgs (hex).
 */
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { dec, encodeDeposit, encodeRun, Engine, ENGINE_PROGRAM_ID, receiveAccounts, slot, svmExtraArgs } from '../src';

const [kind, processArg, a, b, c, d] = process.argv.slice(2);
const conn = new Connection(process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com', 'confirmed');
const engine = new Engine(new AnchorProvider(conn, new Wallet(Keypair.generate()), {}));
const proc = new PublicKey(processArg);
const p = await engine.process(proc);
const { def } = await engine.definition(p.definition);
const hex = (u: Uint8Array) => '0x' + Array.from(u, x => x.toString(16).padStart(2, '0')).join('');
let data: Uint8Array, asset: number, mint: PublicKey;
if (kind === 'run') {
  const step = def.steps.findIndex(s => s.id === a);
  if (step < 0) throw new Error(`no step ${a}`);
  data = encodeRun(proc, step, [slot.number(dec(b))]); asset = Number(c); mint = new PublicKey(d);
} else {
  data = encodeDeposit(proc, Number(a)); asset = Number(b); mint = new PublicKey(c);
}
const r = receiveAccounts(ENGINE_PROGRAM_ID, proc, p.definition, mint, asset);
console.log(JSON.stringify({
  receiver: hex(ENGINE_PROGRAM_ID.toBytes()),
  data: hex(data),
  extraArgs: svmExtraArgs({ computeUnits: 400_000, writableBitmap: r.writableBitmap, tokenReceiver: r.tokenReceiver, accounts: r.accounts }),
}));
