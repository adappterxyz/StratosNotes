# StratosNotes: TOKEN2049 Origins submission

**One line:** a self-service structured-note issuance engine and marketplace.
Anyone can issue an autocallable, worst-of or capital-protected note in
minutes (from a template, a term sheet, a sentence to the AI, or a BPMN
canvas) and sell it to investors on **Solana or Ethereum**. The note runs on
Solana; Chainlink CRE is the calculation and paying agent (it fixes the
strikes, observes every underlying, triggers every coupon, autocall and
redemption, and pays holders on both chains); Chainlink CCIP carries the money
and delivered tokens between the chains.

- Site: https://sp.stratoslab.app
- App: https://sp.stratoslab.app/app (Solana devnet + Ethereum Sepolia; test-token faucets built in)
- Code: https://github.com/adappterxyz/StratosNotes
- Demo script: [DEMO.md](DEMO.md) · Cross-chain details and transactions: [crosschain.md](crosschain.md)

## Tracks

| Track | What we built for it |
|---|---|
| **Best Use of Solana** | One Anchor program, `flow_engine`, runs BPMN workflows on-chain. A compiled workflow is stored once (addressed by its hash) and every issuance is a process of it: a token-multiset state machine with exclusive gateways on price predicates (including `min`/`max` for worst-of baskets), parallel fork/join, timers on per-issuance dates, open roles, repeatable subscription windows, an internal holdings ledger with atomic USDC-for-note DvP, distribute-to-every-holder (cash or the underlying's token), holder transfers in whole or in part, and a token vault per issuance. It is also a CCIP receiver and sender: Ethereum investors subscribe into it (`ccip_receive`) and are paid out of it (`ccip_send`). Five product engines, worst-of baskets, physical delivery, the template library and any workflow edited on the canvas all run on the same program. |
| **Best Workflow with CRE** | `cre/notes-keeper`: one CRE workflow serves every note on the platform. Each cron run reads the engine's notes from Solana (every DON node reads finalized state; the DON agrees on what is due), reads the Chainlink feed of every underlying at the finalized Ethereum block (staleness-checked against the feed's heartbeat), and writes DON-signed reports to Solana through the keystone forwarder (`SolanaClient.writeReport`): one report runs an observation and everything after it (a worst-of report carries all its prices). CRE is also the **paying agent on Ethereum**: for every Sepolia holder with a coupon, redemption or delivered token due, a payout report has the engine lock exactly that amount for CCIP, and a permissionless relay delivers it to that address. Every report fits CRE's 300k compute cap (max 98k measured). |

## The problem

A structured note is a promise about dates and prices: "every quarter, if the
worst of ETH and BTC is at or above 70% of its starting level you get a 2.5%
coupon; if both are at or above 100% you get your money back early". Today a
bank's calculation agent watches those dates, a paying agent moves the money,
and the investor trusts both. Creating one takes weeks and a legal team, and
investors can only buy it where the issuer's platform lives.

## What StratosNotes does

1. **Design (Issue workspace).** One workspace, in the design of
   [Flow](https://flow.stratoslab.app). Start from a published template (six
   are seeded), a term sheet (fixed coupon note, reverse convertible, phoenix
   with memory, snowball or principal-protected; one underlying or a worst-of
   basket of up to three; cash or physical settlement), a sentence to the AI
   (which asks for missing terms instead of inventing them), or a blank
   canvas. Change the workflow itself on the canvas or by asking the AI. The
   stages run Overview/Properties → Validate → Payoff (reference payoff and a
   what-if) → Template → Issue; every change is checked by the validator and
   the engine's compiler as you make it.
2. **Template.** Save any design to the library: the workflow is published on
   Solana once (its address is the hash of its contents), the author signs the
   entry, and the library recompiles it and rejects any entry that does not
   land on the address it names.
3. **Issue.** Set this issuance's size, strike date and observation dates
   (minutes apart for a demo, months for real), deposit the coupon reserve
   (and, for physical settlement, a delivery reserve of each underlying's
   token), and publish: the book opens on the marketplace.
4. **Sell, on either chain.** The marketplace lists every note, open and
   finished, with filters. Solana investors swap USDC for units in one
   transaction. Ethereum investors send tUSD and a subscribe call over CCIP;
   the engine runs the same subscription for their address, or refunds it if
   the book closed while it travelled. Holders can transfer units, in whole or
   in part, to a Solana wallet or an Ethereum address.
5. **Observe and pay, on either chain.** On every date CRE reads the
   Chainlink feeds and writes a signed report; coupons, autocalls, knock-in
   and redemption settle on-chain in that transaction, and the note's page
   updates live. Below a knock-in, a physically settled note delivers units ÷
   strike of the (worst) underlying's token instead of cash. Solana holders
   withdraw when they like; Ethereum holders are paid automatically (CRE
   locks each payout, a relay sends it over CCIP).

## Architecture

```
template / term sheet / AI / canvas ─► BPMN workflow ─► compiler ─► definition (Solana account, by hash)
                                                                     │
                       flow_engine (one Anchor program) runs every issuance on Solana
          on_report (forwarder CPI) ▲            │ ccip_send                  ▲ ccip_receive
                                    │            ▼                            │
Chainlink feeds ─► CRE notes-keeper ─┘   outbox ─► relay ─► CCIP ─► Ethereum investors ─► CCIP
 (ETH, BTC, SOL)   (observations + payout decisions)        (tUSD, tETH, tBTC, tSOL)   (subscribe)
```

- `solana/programs/flow_engine`: the engine (Anchor 0.31.1), devnet
  `9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx`, with its own heap allocator
  so large definitions fit Solana's 32 KiB heap on the report path.
- `packages/flow`: BPMN parser and builder, expression language, compiler and
  Borsh codec, products and their reference payoff, the template library,
  validator, AI pipeline (Cloudflare Workers AI: Clef routes and checks
  required terms, Kimi K2.6 extracts and edits), keeper logic, the engine and
  CCIP client.
- `cre/notes-keeper`: the CRE workflow (TypeScript, `@chainlink/cre-sdk` 1.23).
- `evm/` and `scripts/cct-solana.py`: four CCIP burn-mint cross-chain tokens
  (tUSD, tETH, tBTC, tSOL) self-registered on Sepolia and Solana devnet, and a
  Sepolia faucet; tUSD is the test USDC on Solana.
- CCIP bots: `scripts/ccip-relayer.sh` re-executes inbound messages the DON
  executor could not fit (below); `packages/flow/scripts/ccip-payouts.ts`
  delivers the payouts CRE locked. Both decide nothing; anyone can run them.
- `app`: marketplace, live note pages (subscribe from Solana or with MetaMask
  from Sepolia, holders on both chains), the Issue workspace and the
  portfolio; one Cloudflare Worker serves the landing page, the app, the AI,
  the template library, the faucet and a CCIP status proxy.

It is a rewrite, for Solana, CRE and CCIP, of
[Flow](https://flow.stratoslab.app)'s BPMN compiler and structured-product
engines (Flow targets Canton/Daml); diagrams exported from Flow import
unchanged.

## Evidence (devnet and Sepolia)

CRE runs in Chainlink's simulator every minute with `--broadcast` (real devnet
writes through Chainlink's simulator forwarder).

**A whole life on Solana, run by CRE.** Phoenix on ETH
`8SvcVvQ8vYAtVdLs4gF3Rc1MNybqWh2kFfPCTpD1heGG`: 600 + 400 units subscribed,
then nobody acted except one investor selling part of their position.

| Event | Transaction | Compute units |
|---|---|---|
| CRE fixes the strike (ETH 2,699.34) | `2VxTRWLpY7oD3AD65uE3mo8bfd242xNG5fgTVD3HAik7CN6hFLybKcDdD63EY4fYPXmUn8uK4iTR4UzrkRooQj2r` | 51,394 |
| An investor sells 100 of 600 units | `3umFWgcG84oU8nbu2Mn3r2HUAvMWoQBoEkdh4s75H9QSddCes9fz7RBVRUUXAn6D7aGpVyUK2Eug1r9srgppHSZu` | 34,775 |
| CRE observation 1: 2.5% coupon | `Ju2Wo4k5rzoug8SQwBxsq4KhigaZqDJauxp5N5anAQYg1BDH91FefbFiiFE4iL6xbaQQcEKdqVratVJBX5XRenA` | 68,976 |
| CRE observation 2: coupon, autocall, redemption | `4hySSWXNfSx2oSt5LnwVxegv8s9zXnQFyqz7VjHKWhMZLC37kLovD84K5mhQFCBKUWh3VF3gdDawpJ3VFYhPY8Ed` | 87,593 |

Paid 525, 420 and 105 USDC for 500, 400 and 100 units: exactly the reference
payoff.

**A worst-of basket.** Phoenix on the worst of ETH, BTC and SOL
`3o6EuEWkQ6now9b5TEd85BUEdQGeQfHGotDuLP1LPkUj`: each CRE report carried three
Chainlink prices; the engine computed `perfK = min(obsK_i / initialLevel_i)`
on-chain and tested every barrier against it.

| Event | Transaction | Compute units |
|---|---|---|
| CRE fixes three strikes | `2JoaJh49kYUaSPSWDiKTcquDLgriFvM3Pz1QzbX3ubFjb4hWE6mzvb7NbYKcmYN2Eyc9kigpgZYwENLu1YWSFroR` | 63,723 |
| CRE observation 1: worst 100%, 3% coupon | `3GL2E2Q77txFoawfdu48YiHSbLfhwjxtPmVufZ9YDvdMxB8xAuBhLrpWxz9zs5pBYfzZtr2aZsJS1GyeV6HKTXe4` | 84,063 |
| CRE observation 2: coupon, autocall, redemption | `42Q2F5oRjDKCYYJDFnZsSw5BrnfbyFxdn6hqqcvHXgif5mwr9pZFsaqUnPhm9JjQBi6ToVpRTFmUrLyocATNEjNB` | 99,231 |

Paid 636 and 424 USDC for 600 and 400 units.

**Investors on Ethereum, over CCIP.** One Ethereum address, `0x8ba8…2568`,
across three notes:

| Note | What crossed | Result |
|---|---|---|
| FCN `DFaUHwaGgwWkFAcQ74ZQ9cVGRMisCG4jg67ywFHVQxJm` | **Subscribe in:** 300 tUSD + "subscribe 300" from Sepolia (tx `0xff7248630d184bc2abe4ee9a44fed4d066f1fe340560005f8bdb50086fe271cc`) | 300 units held for the Ethereum address; CRE autocalled; 306 tUSD sent back with `ccip_send`, landed in ~50 s |
| Phoenix `8DtC17ArCQiCPiGezSB1dYfViA3SAoKTE7JynGX7gHe2` | **Automatic payouts out:** 100 units moved to the Ethereum address | CRE locked three coupons and the redemption in four payout reports; the relay delivered each; 110 tUSD (the reference payoff) arrived with nobody acting |
| Reverse convertible, physical `CviXTYq7RJPy7rt5Nw5riHcJXvpSqW8DNByhL9sd4d4C` | **Physical delivery out:** knocked in at maturity | 5 tUSD of coupons and **0.03824647 tETH** (100 units ÷ the 2,614.62 strike) arrived on Sepolia |

Every transaction, compute cost and timing: [crosschain.md](crosschain.md).

**The template library.** Six templates published on devnet, each signed and
recompiled against its definition address: worst-of phoenix (ETH, BTC, SOL),
worst-of FCN (ETH, BTC), BTC snowball, 90%-protected SOL note, and two custom
workflows (a step-down phoenix; a BTC phoenix that pays the paying agent a
fee per coupon, funded with the reserve).

**Tests.**
- `npm run e2e`, products: twelve runs on a local validator: all five
  products, worst-of baskets, physical delivery (single and worst-of), and the
  two custom templates, with a partial transfer mid-life. Every payout equals
  the expected payoff and is withdrawn as SPL tokens; every CRE report is under
  300k compute units (max 98k).
- `npm run e2e`, cross-chain: a mock CCIP router and offramp with the real
  PDAs and call shapes: a Sepolia subscription through `ccip_receive` on a
  partly sold book; a late one refunded without touching the note; the
  autocall paid through the CRE path (forwarder payout report → outbox →
  `flush_outbox` → `ccip_send`).
- Unit tests: every product round-trips BPMN → IR → definition → bytes and
  BPMN → draft → BPMN; `min`/`max`; worst-of payoff; the AI pipeline (clarify
  instead of guess, coupon conversion, refusals, validator-driven repair).
  Foundry tests for the Sepolia faucet.
- The template library rejects forged signatures and mismatched workflows
  (checked against production). The CRE workflow compiles with `cre-compile`.
  The app was checked in a headless browser at desktop, tablet and phone
  widths.

**AI, against the live models.** A full phoenix term sheet becomes the right
parameters in about 7 seconds (10% p.a. quarterly → 2.5% per period); "the
worst of ETH and BTC" becomes a two-asset basket; a request missing terms gets
a question back; "pay the paying agent a 0.1% fee after each coupon" comes
back as a correct, validated workflow change.

## Honest limits

- **CCIP inbound is slow:** Ethereum → Solana takes 35-40 minutes (Ethereum
  finality, then execution), so a book that takes Ethereum subscriptions
  stays open at least 40 minutes (the app enforces it). Outbound takes about a
  minute.
- **The DON executor and our receiver:** on Chainlink's automatic execute
  path, a token transfer plus our seven-account receiver leaves the offramp
  out of heap after our code succeeds, so the message is marked failed; the
  same message succeeds as a manual execution. Our relayer re-executes such
  messages automatically.
- **CRE decides, a relay sends:** CRE locks every payout to Ethereum on-chain,
  but cannot submit the CCIP send itself (the router's accounts need address
  lookup tables, which CRE's Solana writes do not support). The relay that
  delivers is permissionless and cannot change amount or destination.
- CRE runs in Chainlink's simulator with `--broadcast` until DON deploy
  access is granted; the engine already accepts the staging DON forwarder.
- Note units live in the engine's ledger (transferable in whole or in part, to
  either chain's address) but are not SPL tokens yet, so wallets do not show
  them.
- Up to about 30 investors, 12 observations and 3 underlyings per issuance.
  Prices come from Chainlink feeds on Ethereum mainnet; the traded assets are
  testnet tokens we registered with CCIP, not real USDC or ETH. We chose
  our own burn-mint tokens (tUSD, tETH, tBTC, tSOL) so we control the
  Sepolia ↔ Solana devnet lane and a faucet can mint demo amounts on
  demand. A note's cash and delivery assets are mint addresses, so pointing
  it at USDC on a supported lane needs no engine change.
- The issuer's reserves are deposited on Solana in the app (the engine also
  accepts them from Ethereum over CCIP; there is no button for that yet).
- An edited workflow's payoff is the workflow itself: the app charts a
  reference payoff only for unedited products.
- Minute-apart observations often see the same price (ETH/USD and BTC/USD
  update hourly or on a 0.5% move, SOL/USD daily).

## What's next

- `cre workflow deploy` to the DON, and CRE log triggers on the engine's events.
- Note units as SPL tokens (Token-2022 with the engine as permanent delegate),
  transferable across chains over CCIP.
- More CCIP chains (Base, Arbitrum), a smaller receiver footprint so the DON
  executor delivers subscriptions directly, and issuer reserves from Ethereum
  in the app.
- Per-offering investor allowlists, template ratings and issuer profiles, and
  Flow's Canton target for private institutional issuance from the same BPMN.
