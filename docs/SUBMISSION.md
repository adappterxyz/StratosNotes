# StratosNotes: TOKEN2049 Origins submission

**One line:** a self-service structured-note issuance engine and marketplace
on Solana, with investors on Ethereum too (Chainlink CCIP). Anyone can issue an autocallable, worst-of or capital-protected note
in minutes (from a template, a term sheet, a sentence to the AI, or a BPMN
canvas), sell it to anyone for USDC, and let Chainlink CRE act as the
calculation agent: it fixes the strikes, observes every underlying on every
date and triggers every coupon, autocall and redemption.

- Site: https://sp.stratoslab.app
- App: https://sp.stratoslab.app/app (Solana devnet, test USDC faucet built in)
- Code: https://github.com/adappterxyz/StratosNotes
- Demo script: [DEMO.md](DEMO.md)

## Tracks

| Track | What we built for it |
|---|---|
| **Best Use of Solana** | One Anchor program, `flow_engine`, runs BPMN workflows on-chain. A compiled workflow is stored once (addressed by its hash) and every issuance is a process of it: a token-multiset state machine with exclusive gateways on price predicates (including `min`/`max` for worst-of baskets), parallel fork/join, timers on per-issuance dates, open roles, repeatable subscription windows, an internal holdings ledger with atomic USDC-for-note DvP, distribute-to-every-holder, holder transfers in whole or in part, and a USDC vault per issuance. Five product engines, worst-of baskets, the template library and any workflow edited on the canvas all run on the same program. The app reads everything from chain and follows each note's account over a WebSocket, so pages update the moment a report lands. |
| **Cross-chain (Chainlink CCIP)** | Investors on Ethereum Sepolia subscribe to a Solana note by sending tUSD and a "subscribe" call over CCIP; the engine receives it (`ccip_receive`), runs the subscription for their Ethereum address, and later sends coupons, redemptions and physically delivered tokens back with the CCIP router's `ccip_send`. Four cross-chain tokens (tUSD, tETH, tBTC, tSOL) are self-registered CCIP burn-mint tokens on both chains. A full lifecycle ran across both testnets (below). |
| **Best Workflow with CRE** | `cre/notes-keeper`: one CRE workflow serves every note on the platform. Each cron run reads the engine's running processes from Solana (every DON node reads finalized state; the DON agrees on what is due), reads the Chainlink feed of every underlying named in each workflow at the finalized Ethereum block (staleness-checked against the feed's heartbeat; each feed read once per run), and writes a DON-signed report to Solana through the keystone forwarder (`SolanaClient.writeReport`). A worst-of note's report carries all its prices at once. The engine accepts prices only from Chainlink's forwarder programs and bounds-checks them; one report runs the observation and everything after it. Every report fits CRE's 300k compute cap (max 99k measured, three feeds in one report). |

## The problem

A structured note is a promise about dates and prices: "every quarter, if the
worst of ETH and BTC is at or above 70% of its starting level you get a 2.5%
coupon; if both are at or above 100% you get your money back early". Today a
bank's calculation agent watches those dates, a paying agent moves the money,
and the investor trusts both. Creating one takes weeks and a legal team;
secondary transfers go through the same intermediaries.

## What StratosNotes does

1. **Design (Issue workspace).** One workspace, in the design of
   [Flow](https://flow.stratoslab.app). Start from:
   - a published template: six are seeded, and issuers add their own;
   - a term sheet: fixed coupon note, reverse convertible, phoenix with memory,
     snowball or principal-protected, on one underlying or a worst-of basket of
     up to three (ETH, BTC, SOL);
   - a sentence to the AI ("12M phoenix on the worst of ETH and BTC, 10% p.a.
     quarterly…"), which asks for missing terms instead of inventing them;
   - or a blank canvas.

   Then change the workflow itself on the canvas or by asking the AI: add a
   fee, step the autocall level down, pay a bonus on autocall. The stages run
   in order: Overview/Properties → Validate → Payoff (reference payoff and a
   what-if) → Template → Issue. Every change is checked by the validator and
   the engine's compiler as you make it.
2. **Template.** Save any design to the library: the workflow is published on
   Solana once (its address is the hash of its contents) and the author signs
   the entry with their wallet. The library recompiles every entry and rejects
   one that does not land on the address it names, so a template always opens
   what it says.
3. **Issue.** Set this issuance's size, strike date and observation dates
   (minutes apart for a demo, months for real), deposit the coupon reserve, and
   publish: the book opens on the marketplace. Issuance works for any workflow:
   roles, the start event and the pre-trade steps are read from the diagram.
4. **Sell.** The marketplace lists every note, open and finished, filtered by
   status, product, underlying or text (completed lifecycles hidden by
   default). Investors subscribe with USDC until the strike date; each
   subscription is one atomic USDC-for-note swap. Investors on Ethereum
   Sepolia subscribe the same way over Chainlink CCIP and are paid back
   there. Holders can transfer their units, in whole or in part; later
   coupons follow the units.
5. **Observe and pay.** On the strike date and every observation date, CRE
   reads the Chainlink feeds and writes a signed report; coupons, autocalls,
   knock-in and redemption settle on-chain in that transaction, and the note's
   page updates live. A note can settle in cash or by **physical delivery**:
   below the knock-in, holders receive units ÷ strike of the (worst)
   underlying's token from a delivery reserve the issuer deposited. Investors
   withdraw on Solana, or receive on Sepolia over CCIP.

## Architecture

```
template / term sheet / AI / canvas ─► BPMN workflow ─► compiler ─► definition (Solana account, by hash)
            ▲                                                    │
   template library (Worker; signed, recompiled)   flow_engine (one Anchor program) runs every issuance
                                                                 ▲ on_report (forwarder CPI)
Chainlink feeds (ETH, BTC, SOL) ─► CRE notes-keeper ─► keystone forwarder
```

- `solana/programs/flow_engine`: the engine (Anchor 0.31.1), deployed on devnet
  at `9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx`. It has its own heap
  allocator: it grows and frees the latest allocation in place, so large
  definitions fit Solana's 32 KiB heap on the report path, where a
  transaction cannot ask for more.
- `packages/flow`: BPMN parser and builder, expression language, compiler and
  Borsh codec, structured products (single and worst-of) and their reference
  payoff, the template library, validator, AI pipeline (Cloudflare Workers AI:
  Clef routes and checks required terms, Kimi K2.6 extracts and edits), keeper
  logic, client.
- `cre/notes-keeper`: the CRE workflow (TypeScript, `@chainlink/cre-sdk` 1.23).
- `app`: the marketplace, live note pages, the Issue workspace and the
  portfolio; one Cloudflare Worker serves the landing page, the app, the AI
  endpoint, the template library and the test-USDC faucet.

It is a rewrite, for Solana and CRE, of [Flow](https://flow.stratoslab.app)'s
BPMN compiler and structured-product engines (Flow targets Canton/Daml);
diagrams exported from Flow import unchanged.

## Evidence

**On-chain, devnet, run by CRE with nobody acting after issuance.** Phoenix on
ETH `8SvcVvQ8vYAtVdLs4gF3Rc1MNybqWh2kFfPCTpD1heGG`: 600 + 400 units subscribed;
the keeper loop (the CRE workflow in Chainlink's simulator, every minute,
broadcasting through Chainlink's simulator forwarder `7kuEAA3m…`):

| Event | Transaction | Compute units |
|---|---|---|
| CRE fixes the strike (ETH 2,699.34) | `2VxTRWLpY7oD3AD65uE3mo8bfd242xNG5fgTVD3HAik7CN6hFLybKcDdD63EY4fYPXmUn8uK4iTR4UzrkRooQj2r` | 51,394 |
| An investor sells 100 of 600 units | `3umFWgcG84oU8nbu2Mn3r2HUAvMWoQBoEkdh4s75H9QSddCes9fz7RBVRUUXAn6D7aGpVyUK2Eug1r9srgppHSZu` | 34,775 |
| CRE observation 1: 2.5% coupon | `Ju2Wo4k5rzoug8SQwBxsq4KhigaZqDJauxp5N5anAQYg1BDH91FefbFiiFE4iL6xbaQQcEKdqVratVJBX5XRenA` | 68,976 |
| CRE observation 2: coupon, autocall, redemption | `4hySSWXNfSx2oSt5LnwVxegv8s9zXnQFyqz7VjHKWhMZLC37kLovD84K5mhQFCBKUWh3VF3gdDawpJ3VFYhPY8Ed` | 87,593 |

Paid: 525, 420 and 105 USDC for 500, 400 and 100 units (par plus two 2.5%
coupons), exactly the reference payoff; the issuer's reserve kept the rest.
An earlier FCN (`2eWVSt8MRqR8wMBu3ZWiWmj85YUdwzoACyyQWgT3Gu5B`) autocalled at
its first CRE observation and paid 612 and 408 USDC for 600 and 400 units.

**A worst-of basket on devnet, same keeper.** Phoenix on the worst of ETH, BTC
and SOL `3o6EuEWkQ6now9b5TEd85BUEdQGeQfHGotDuLP1LPkUj`: each CRE report carried
all three Chainlink prices; the engine computed the worst performance
on-chain (`perfK = min(obsK_i / initialLevel_i)`) and tested every barrier
against it.

| Event | Transaction | Compute units |
|---|---|---|
| CRE fixes three strikes (ETH 2,698.11, BTC 85,512.70, SOL 121.64) | `2JoaJh49kYUaSPSWDiKTcquDLgriFvM3Pz1QzbX3ubFjb4hWE6mzvb7NbYKcmYN2Eyc9kigpgZYwENLu1YWSFroR` | 63,723 |
| CRE observation 1: worst 100%, 3% coupon | `3GL2E2Q77txFoawfdu48YiHSbLfhwjxtPmVufZ9YDvdMxB8xAuBhLrpWxz9zs5pBYfzZtr2aZsJS1GyeV6HKTXe4` | 84,063 |
| CRE observation 2: coupon, autocall, redemption | `42Q2F5oRjDKCYYJDFnZsSw5BrnfbyFxdn6hqqcvHXgif5mwr9pZFsaqUnPhm9JjQBi6ToVpRTFmUrLyocATNEjNB` | 99,231 |

Paid: 636 and 424 USDC for 600 and 400 units (par plus two 3% coupons).

**Across Solana and Ethereum, over CCIP.** FCN `DFaUHwaGgwWkFAcQ74ZQ9cVGRMisCG4jg67ywFHVQxJm`:
two Solana investors subscribed 600 and 400 units; an investor on Sepolia
(`0x8ba8…2568`) subscribed 300 by sending 300 tUSD and a Subscribe call over
CCIP (Sepolia tx `0xff7248630d184bc2abe4ee9a44fed4d066f1fe340560005f8bdb50086fe271cc`);
CRE fixed the strike and autocalled at observation 1; `withdraw_remote` sent
the investor's 306 tUSD back through the CCIP router (Solana tx
`4jEafTtRiMW38eP2QDtduW1PdeVaM1H4G9QynDqXtLzYYQbp3hcX8vpubQ5mW2CQoE8K2LLRVPYUpQoBCFJFq6BB`),
landing on Sepolia 50 seconds later. Every step and its transaction:
[crosschain.md](crosschain.md).

**The template library, seeded.** Six templates are published on devnet and
listed in the app, each signed by its author and recompiled by the library
against its definition address:

| Template | Kind |
|---|---|
| 12M Worst-of Phoenix on ETH, BTC, SOL | product, worst-of |
| 12M Worst-of FCN on ETH, BTC | product, worst-of |
| 12M Snowball on BTC | product |
| 6M 90% Protected Note on SOL | product |
| 12M Step-down Phoenix on ETH (autocall 100% at Q2, 95% at Q3) | custom workflow |
| 12M Phoenix on BTC with servicing fee (0.1% of size to the paying agent per coupon, funded with the reserve) | custom workflow |

The two custom templates are product workflows edited through the same draft
format the AI edits; both run end to end in the test suite below.

**Tests.**
- `npm run e2e`, products: twelve runs on a local validator. All five
  products, including a worst-of phoenix on ETH, BTC and SOL and a worst-of FCN
  knocked in by its worst performer, physical delivery (a knocked-in ETH note
  delivers units ÷ strike of tETH; a worst-of basket delivers its worst
  performer's token), and the two custom templates (the step-down phoenix calls
  at 96% where the stock one would not; the fee phoenix pays investors the
  reference payoff while the paying agent collects its fees). Two investors
  each and one partial transfer mid-life. Every payout equals the expected
  payoff and is withdrawn as SPL tokens; every CRE report is under 300k compute
  units (max 98k).
- `npm run e2e`, cross-chain: a mock CCIP router and offramp with the real PDAs
  and call shapes. A Sepolia subscription through `ccip_receive` on a partly
  sold book; a late one refunded to its sender without touching the note; the
  autocall paid to the Ethereum address; `withdraw_remote` through `ccip_send`.
- Unit tests: every product (single and worst-of) round-trips BPMN → IR →
  definition → bytes, and BPMN → draft → BPMN; `min`/`max` parse and compile;
  the worst-of payoff with one underlying equals the single-asset payoff; the
  AI pipeline (clarify instead of guess, coupon conversion, unsupported
  underlyings refused, validator-driven repair of edits). Foundry tests for the
  Sepolia token faucet.
- The template library rejects a forged signature and a workflow that does not
  match its definition address (checked against production).
- The CRE workflow compiles with the official `cre-compile`; the app was
  checked in a headless browser at desktop, tablet and phone widths.

**AI, against the live models.** A full phoenix term sheet becomes the right
parameters in about 7 seconds (10% p.a. quarterly → 2.5% per period); "the
worst of ETH and BTC" becomes a two-asset basket; a request missing terms gets
a question back; "pay the paying agent a 0.1% fee after each coupon" and
"investors get an extra 1% when it autocalls" come back as correct, validated
workflow changes.

## Honest limits

- CCIP inbound (Sepolia → Solana) takes about 35-40 minutes (Ethereum
  finality, then execution), so a book that takes Sepolia subscriptions stays
  open at least 40 minutes. On the DON's execute path the offramp runs out of
  heap after our receiver returns (token transfer + a seven-account receiver);
  our relayer re-executes such messages manually, which succeeds. Outbound
  (Solana → Sepolia) takes about a minute.
- CRE runs in Chainlink's simulator with `--broadcast` (real devnet writes
  through Chainlink's simulator forwarder) until deploy access is granted; the
  engine already accepts the staging DON forwarder.
- Note units live in the engine's ledger: transferable in whole or in part,
  but not SPL tokens yet, so wallets and DEXs do not show them.
- Up to about 30 investors, 12 observations and 3 underlyings per issuance.
  Prices come from Chainlink feeds on Ethereum mainnet. The traded assets are
  testnet tokens: tUSD for cash and tETH, tBTC, tSOL for physical delivery
  (CCIP cross-chain tokens we registered), not the real assets.
- Sepolia holders receive payouts when someone sends them home
  (`withdraw_remote`, a button on the note page; the caller pays the CCIP fee
  in SOL); it is not automatic yet.
- An edited workflow's payoff is the workflow itself: the app charts a
  reference payoff only for unedited products, and the issuer sizes the
  reserve for anything the edit adds (the fee template deposits its fees for
  you).
- Data is public on Solana; Flow's Canton target keeps it private.
- Minute-apart observations often see the same price: ETH/USD and BTC/USD
  update hourly or on a 0.5% move, SOL/USD daily.

## What's next

- `cre workflow deploy` to the DON and CRE log triggers on the engine's events.
- Note units as SPL tokens (Token-2022 with the engine as permanent delegate)
  for wallet visibility and secondary markets, transferable across chains over
  CCIP.
- Automatic payouts to Sepolia holders (the keeper sending them home after
  each coupon), more CCIP chains (Base, Arbitrum), and a smaller CCIP receiver
  footprint so the DON executor delivers subscriptions without the relayer.
- Per-offering investor allowlists, template ratings and issuer profiles, and
  Flow's Canton target for private institutional issuance from the same BPMN.
