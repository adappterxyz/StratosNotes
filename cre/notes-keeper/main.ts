// StratosNotes keeper: one Chainlink CRE workflow that runs the oracle steps
// of EVERY note issued on the StratosNotes engine (Solana).
//
// Each cron run:
//  1. Lists the engine's running processes and their definitions from Solana
//     (JSON-RPC through the HTTP capability; each node computes the due list
//     from finalized state and the DON agrees on it).
//  2. For each due oracle step (strike fixing, observation k), reads the
//     Chainlink price feed of every underlying named in the definition (one
//     for a single-asset note, several for a worst-of basket) through the EVM
//     capability (finalized block, staleness-checked).
//  3. Writes a DON-signed report to the engine through the keystone
//     forwarder: on_report runs the step and everything after it that needs
//     nobody (coupons, autocall, redemption), straight through.
import {
  bytesToHex, consensusIdenticalAggregation, cre, encodeCallMsg, encodeForwarderReport, calculateAccountsHash, getNetwork,
  LAST_FINALIZED_BLOCK_NUMBER, ok, prepareSolanaReportRequest, Runner, SolanaClient, SolanaTxStatus, solanaAccountMeta,
  solanaAccountMetasToJson, solanaAddressToBytes, text, type HTTPSendRequester, type Runtime,
} from '@chainlink/cre-sdk'
import { PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { decodeDefinitionAccount, decodeProcess, dueOracleSteps, feedToFixed, reportPayload, type DueOracle } from '../../packages/flow/src/keeper'

const configSchema = z.object({
  /** 6-field cron, e.g. "0 * * * * *" = every minute. */
  schedule: z.string(),
  solana: z.object({
    chainSelectorName: z.string(),
    /** Solana JSON-RPC used to list processes (HTTP capability). */
    rpcUrl: z.string(),
    engineProgramId: z.string(),
    /** Chainlink keystone forwarder state + program for this environment. */
    forwarderState: z.string(),
    forwarderProgramId: z.string(),
    computeLimit: z.number().int().positive(),
  }),
  /** Reports written per run (each is one Solana transaction). */
  maxReportsPerRun: z.number().int().positive(),
  /**
   * Feeds are read at the last FINALIZED block (~15 min behind on Ethereum), so
   * a round may be older than the feed's heartbeat by that lag: allowed on top
   * of each feed's own staleness limit.
   */
  finalityAllowanceSec: z.number().int().nonnegative(),
})
type Config = z.infer<typeof configSchema>

const PROCESS_DISCRIMINATOR_B64 = 'YZCwotTlC8c=' // sha256("account:Process")[..8]
const STATUS_OFFSET = 81 // discriminator 8 | definition 32 | id 8 | creator 32 | bump 1 | status

// QuickJS has no atob/Buffer: decode base64 by hand.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function b64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0, buf = 0, bits = 0
  for (const c of clean) {
    buf = (buf << 6) | B64.indexOf(c)
    bits += 6
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff }
  }
  return out
}

type Rpc = (method: string, params: unknown[]) => any

/** Runs on each node: read finalized Solana state, compute what is due. Identical across honest nodes. */
const findDue = (sendRequester: HTTPSendRequester, cfg: Config['solana'], nowSec: number): string => {
  const rpc: Rpc = (method, params) => {
    const resp = sendRequester.sendRequest({
      url: cfg.rpcUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bytesToB64(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))),
    }).result()
    if (!ok(resp)) throw new Error(`${method}: HTTP ${resp.statusCode}`)
    const j = JSON.parse(text(resp))
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
    return j.result
  }
  const procs = rpc('getProgramAccounts', [cfg.engineProgramId, {
    encoding: 'base64', commitment: 'finalized',
    filters: [{ memcmp: { offset: 0, bytes: PROCESS_DISCRIMINATOR_B64, encoding: 'base64' } }, { memcmp: { offset: STATUS_OFFSET, bytes: 'AA==', encoding: 'base64' } }],
  }]) as Array<{ pubkey: string; account: { data: [string, string] } }>
  const decoded = procs.map(p => ({ key: p.pubkey, p: decodeProcess(b64(p.account.data[0])) }))
  const defKeys = [...new Set(decoded.map(d => new PublicKey(d.p.definition).toBase58()))].sort()
  const defs = new Map<string, ReturnType<typeof decodeDefinitionAccount>>()
  if (defKeys.length) {
    const infos = rpc('getMultipleAccounts', [defKeys, { encoding: 'base64', commitment: 'finalized' }]).value as Array<{ data: [string, string] } | null>
    defKeys.forEach((k, i) => defs.set(k, infos[i] ? decodeDefinitionAccount(b64(infos[i]!.data[0])) : null))
  }
  const due: DueOracle[] = []
  for (const { key, p } of decoded.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const dk = new PublicKey(p.definition).toBase58()
    const def = defs.get(dk)
    if (!def) continue
    for (const d of dueOracleSteps(p, def, nowSec)) due.push({ ...d, process: key, definition: dk })
  }
  return JSON.stringify(due)
}

function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=')
  }
  return s
}

/** Chainlink feed answer as engine fixed point (10 decimals), staleness-checked, finalized block. */
function readFeed(runtime: Runtime<Config>, feed: DueOracle['feeds'][number]): bigint {
  const maxAge = feed.staleness + runtime.config.finalityAllowanceSec
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: feed.feedChain })
  if (!network) throw new Error('unknown feed chain ' + feed.feedChain)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const call = (data: string) => bytesToHex(evm.callContract(runtime, {
    call: encodeCallMsg({ from: '0x0000000000000000000000000000000000000000', to: feed.feed as `0x${string}`, data: data as `0x${string}` }),
    blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
  }).result().data)
  const round = call('0xfeaf968c') // latestRoundData()
  const decimals = Number(BigInt('0x' + call('0x313ce567').slice(2) || '0')) // decimals()
  const words = round.slice(2).match(/.{64}/g) ?? []
  if (words.length < 4) throw new Error('malformed latestRoundData from ' + feed.feed)
  const answer = BigInt.asIntN(256, BigInt('0x' + words[1]))
  const updatedAt = Number(BigInt('0x' + words[3]))
  const now = Math.floor(runtime.now().getTime() / 1000)
  if (answer <= 0n) throw new Error('non-positive answer from ' + feed.feed)
  if (now - updatedAt > maxAge) throw new Error(`stale round from ${feed.feed} (updated ${updatedAt}, max age ${maxAge}s)`)
  return feedToFixed(answer, decimals)
}

export const onCron = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config
  const nowSec = Math.floor(runtime.now().getTime() / 1000)
  const http = new cre.capabilities.HTTPClient()
  const due = JSON.parse(
    http.sendRequest(runtime, findDue, consensusIdenticalAggregation<string>())(cfg.solana, nowSec).result(),
  ) as DueOracle[]
  runtime.log(`due oracle steps: ${due.length}`)

  const network = getNetwork({ chainFamily: 'solana', chainSelectorName: cfg.solana.chainSelectorName })
  if (!network) throw new Error('unknown Solana chain ' + cfg.solana.chainSelectorName)
  const solana = new SolanaClient(network.chainSelector.selector)
  const engine = new PublicKey(cfg.solana.engineProgramId)
  const [config] = PublicKey.findProgramAddressSync([new TextEncoder().encode('config')], engine)
  const [authority] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('forwarder'), new PublicKey(cfg.solana.forwarderState).toBytes(), engine.toBytes()],
    new PublicKey(cfg.solana.forwarderProgramId),
  )

  const done: string[] = []
  // A worst-of note reads one feed per underlying; read each feed once per run, whatever needs it.
  const prices = new Map<string, bigint>()
  const price = (f: DueOracle['feeds'][number]) => {
    const k = `${f.feedChain}:${f.feed}:${f.staleness}`
    if (!prices.has(k)) prices.set(k, readFeed(runtime, f))
    return prices.get(k)!
  }
  for (const d of due.slice(0, cfg.maxReportsPerRun)) {
    const values = d.feeds.map(price)
    // Forwarder layout: state, its authority PDA, then on_report's accounts.
    const accounts = [
      solanaAccountMeta(cfg.solana.forwarderState, true),
      solanaAccountMeta(authority.toBase58()),
      solanaAccountMeta(config.toBase58()),
      solanaAccountMeta(d.process, true),
      solanaAccountMeta(d.definition),
    ]
    const payload = reportPayload(solanaAddressToBytes(d.process), d.step, values)
    const report = runtime.report(prepareSolanaReportRequest(encodeForwarderReport({ accountHash: calculateAccountsHash(accounts), payload }))).result()
    const resp = solana.writeReport(runtime, {
      remainingAccounts: solanaAccountMetasToJson(accounts),
      receiver: bytesToHex(engine.toBytes()),
      computeConfig: { computeLimit: cfg.solana.computeLimit },
      report,
    }).result()
    const ok = resp.txStatus === SolanaTxStatus.SUCCESS
    runtime.log(`${d.process} ${d.stepId} [${values.join(',')}] -> ${ok ? 'written' : 'failed: ' + (resp.errorMessage || resp.txStatus)}`)
    if (ok) done.push(`${d.process}:${d.stepId}`)
  }
  return JSON.stringify({ due: due.length, written: done })
}

export const initWorkflow = (config: Config) => [
  cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCron),
]

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}

main()
