# StratosNotes

**Self-service structured product issuance and marketplace on Solana, with the
note lifecycle run by Chainlink CRE.** Built at TOKEN2049 Origins for *Best Use
of Solana* and *Best Workflow with CRE*.

An issuer picks a payoff (fixed coupon note, reverse convertible, phoenix with
memory, snowball, principal-protected note), sets this issuance's size, strike
date and observation dates, deposits a coupon reserve in USDC, and the book
opens. Investors subscribe with USDC from the marketplace until the strike
date. From then on nobody has to do anything: a Chainlink CRE workflow fixes
the strike from a Chainlink price feed on the strike date, observes on every
date, and each observation runs the payoff on-chain: coupons, autocall,
knock-in, redemption. Investors withdraw what they are paid.

Site: https://sp.stratoslab.app · App: https://sp.stratoslab.app/app · Submission: [docs/SUBMISSION.md](docs/SUBMISSION.md) · Demo script: [docs/DEMO.md](docs/DEMO.md)

## How it works

```
 term sheet ──► BPMN workflow ──► compiled definition ──► Solana: flow_engine
 (5 payoffs)    Issuer / Paying    (Borsh, content-        one program runs every
                Agent / Investor    addressed account)      issuance as a process
                                                                  ▲
 Chainlink price feed ──► CRE notes-keeper ──► keystone forwarder ┘ on_report
 (ETH/USD, BTC/USD, …)    (cron: find due oracle steps, read feed, write report)
```

- **Products are BPMN workflows, not bespoke contracts.** Each product is
  instantiated into a three-pool BPMN collaboration: the *Issuer* approves the
  pre-trade terms (size, strike date, observation dates) and deposits the
  reserve; the *Paying Agent* issues the note, fixes the strike and observes
  (oracle steps), pays coupons, autocalls and redeems through gateways whose
  conditions are expressions like `obs2 >= initialLevel * 100 / 100`; the
  *Investor* pool is an **open role**: its *Subscribe* step is a repeatable
  window that anyone can run until the strike date, each run depositing USDC
  and receiving note units in one atomic DvP.
- **One engine program runs every workflow.** `flow_engine` stores each
  compiled workflow once, addressed by its SHA-256 (same terms, same
  definition), and runs any number of processes (issuances) of it: a token
  multiset (parallel fork/join), exclusive gateways with predicates, timers on
  fixed dates or date fields, receive guards, formula and oracle captures, an
  internal holdings ledger with mint / transfer / DvP swap / distribute-to-every-holder,
  and a USDC vault per process. Everything that needs no one runs straight
  through in the same transaction, so CRE only has to deliver prices.
- **CRE is the calculation agent.** One CRE workflow (`cre/notes-keeper`)
  serves every issuance: each run lists the engine's running processes from
  Solana (each DON node reads finalized state and the DON agrees on the due
  list), reads the Chainlink feed named in each definition at the finalized
  Ethereum block, and writes a DON-signed report. The keystone forwarder
  verifies it and calls the engine's `on_report`, which accepts reports only
  from Chainlink's forwarder programs and bounds-checks every price.
- **Exact arithmetic.** Prices and amounts are 10-decimal fixed point on-chain;
  the reference payoff (`packages/flow/src/products/payoff.ts`) is the spec
  every product is tested against.

It is a rewrite, for Solana and CRE, of [Flow](https://flow.stratoslab.app)'s
BPMN compiler and structured-product engines (which target Canton/Daml);
diagrams exported from Flow import unchanged.

## Verified

| What | How |
|---|---|
| Every product pays its reference payoff | `npm run e2e`: six price paths (FCN autocalled and knocked in, reverse convertible, phoenix with memory, snowball called at maturity, PPN) on a local validator, two investors each, issued, subscribed, observed through a forwarder CPI, payouts withdrawn as SPL USDC and checked against the reference payoff |
| CRE drives a real issuance on devnet | `cre workflow simulate --broadcast`: the keeper found the due strike fixing, read ETH/USD from Chainlink, and wrote it through Chainlink's simulator forwarder into the devnet engine (≈50k compute units, under CRE's 300k cap); the next run delivered observation 1, the FCN autocalled, and both investors were paid par + coupon |
| A full lifecycle on devnet, CRE on a schedule, with a secondary transfer | Phoenix `8SvcVvQ8vYAtVdLs4gF3Rc1MNybqWh2kFfPCTpD1heGG`: issued, subscribed 600 + 400 units, then the keeper loop (CRE simulator every minute) fixed the strike and delivered observations 1 and 2 with nobody else acting; after the strike one investor sold 100 of 600 units; observation 2 autocalled. Paid: 525, 420 and 105 USDC for 500, 400 and 100 units (two 2.5% coupons + par) |
| Every report fits CRE's compute cap | the e2e run measures each forwarder transaction: max 89k compute units (CRE allows 300k) |
| AI | live Workers AI: term sheets to parameters (p.a. coupons converted, missing terms asked for, unsupported underlyings refused); edits to the open workflow as validated patches |
| Compiler | unit tests: every product round-trips BPMN → IR → definition → bytes → decode, and BPMN → draft → BPMN |

## Deployed (Solana devnet)

| | Address |
|---|---|
| Engine program | `9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx` |
| Engine config (accepted forwarders) | `CVpuv1Mu3JEpWM4aUD7VbCqfrzGobG3oLmpdUFWX4Zm` |
| Test USDC mint (6 decimals) | `ATn589uY1YL3o7Bz1E3NBguissueVKtQD2tcbHDyNnB6` (faucet in the app) |
| App | https://sp.stratoslab.app/app |
| Chainlink forwarders accepted | `7kuEAA3m…` (CRE simulator), `CXsKEJcs…` (staging DON) |

## Repository

| Path | What |
|---|---|
| `solana/programs/flow_engine` | The engine (Anchor 0.31.1) |
| `solana/programs/mock_forwarder` | Local stand-in for the keystone forwarder (same CPI shape), for tests |
| `packages/flow` | BPMN parser/builder, expression language, compiler + Borsh codec, products and reference payoff, keeper logic, client |
| `cre/notes-keeper` | The Chainlink CRE workflow |
| `app` | Marketplace, offering pages, self-service issuance, studio, portfolio (React + Solana wallet adapter), served at sp.stratoslab.app/app; its Worker also serves the landing page, the AI endpoint and the faucet (`npm run deploy` in `app` builds and deploys both) |
| `landing` | The landing page at sp.stratoslab.app (built into the app Worker) |
| `scripts/e2e.sh` | Every product end to end on a local validator |

## Run it

```bash
npm install
npm run build:programs                 # anchor build (Anchor 0.31.1)
npm test                               # compiler + products
npm run e2e                            # local validator, every product
cd packages/flow && npx tsx scripts/devnet.ts issue phoenix   # a short-dated note on devnet
cd cre && cre workflow simulate ./notes-keeper --target simulation-settings --broadcast
npm -w app run dev                     # the marketplace on http://localhost:5190
```

`cre/.env` needs `CRE_SOLANA_PRIVATE_KEY` (a funded devnet key that pays the
simulated write) and `CRE_ETH_PRIVATE_KEY` (required by `--broadcast`); see
`cre/.env.example`.

## Limits (hackathon scope)

- Settlement is in cash (below the knock-in barrier a holder receives
  final / strike). Note units live in the engine's ledger: holders transfer
  them in whole or in part with `transfer_units`, but they are not SPL tokens,
  so wallets and DEXs do not see them.
- Up to 64 holdings per issuance (about 30 investors) and 12 observations.
- Field values are public on Solana; Flow's Canton target keeps them private.
