# StratosNotes: TOKEN2049 Origins submission

**One line:** a self-service structured-note desk on Solana. Anyone can design
and issue an autocallable or capital-protected note in minutes (from a form,
a sentence to the AI, or a BPMN editor), sell it to anyone for USDC, and let
Chainlink CRE act as the calculation agent: it fixes the strike, observes the
underlying on every date and triggers every coupon, autocall and redemption.

- Site: https://sp.stratoslab.app
- App: https://sp.stratoslab.app/app (Solana devnet, test USDC faucet built in)
- Code: https://github.com/adappterxyz/StratosNotes
- Demo script: [DEMO.md](DEMO.md)

## Tracks

| Track | What we built for it |
|---|---|
| **Best Use of Solana** | One Anchor program, `flow_engine`, runs BPMN workflows on-chain. A compiled workflow is stored once (addressed by its hash) and every issuance is a process of it: a token-multiset state machine with exclusive gateways on price predicates, parallel fork/join, timers on per-issuance dates, open roles, repeatable subscription windows, an internal holdings ledger with atomic USDC-for-note DvP, distribute-to-every-holder, holder transfers, and a USDC vault per issuance. Five structured products and any workflow edited in the studio run on the same program. |
| **Best Workflow with CRE** | `cre/notes-keeper`: one CRE workflow serves every note on the platform. Each cron run reads the engine's running processes from Solana (every DON node reads finalized state; the DON agrees on what is due), reads the Chainlink feed named in each workflow at the finalized Ethereum block (staleness-checked against the feed's heartbeat), and writes a DON-signed report to Solana through the keystone forwarder (`SolanaClient.writeReport`). The engine accepts prices only from Chainlink's forwarder programs and bounds-checks them; one report runs the observation and everything after it. Every report fits CRE's 300k compute cap (max 89k measured). |

## The problem

A structured note is a promise about dates and prices: "every quarter, if ETH
is at or above 70% of its starting level you get a 2.5% coupon; if it is at or
above 100% you get your money back early". Today a bank's calculation agent
watches those dates, a paying agent moves the money, and the investor trusts
both. Creating one takes weeks and a legal team; secondary transfers go through
the same intermediaries.

## What StratosNotes does

1. **Design.** Pick a payoff (fixed coupon note, reverse convertible, phoenix
   with memory, snowball, principal-protected), describe it to the AI ("12M
   phoenix on ETH, 10% p.a. quarterly, 70% barrier with memory…"), or open it
   in the studio and change the workflow itself: add a fee, change a barrier,
   pay a bonus on autocall. The AI asks for missing terms instead of
   inventing them, and every edit is checked by the validator and compiler.
2. **Issue.** Set this issuance's size, strike date and observation dates
   (minutes apart for a demo, months for real), deposit a coupon reserve.
   The note is a BPMN workflow (Issuer, Paying Agent, Investor) compiled to an
   on-chain definition; the book opens on the marketplace.
3. **Sell.** Investors subscribe with USDC until the strike date; each
   subscription is one atomic USDC-for-note swap. Holders can transfer their
   units, in whole or in part; later coupons follow the units.
4. **Observe and pay.** On the strike date and every observation date, CRE
   reads the Chainlink feed and writes a signed report; coupons, autocalls,
   knock-in and redemption settle on-chain in that transaction. Investors
   withdraw USDC when they like.

## Architecture

```
term sheet / AI / studio ─► BPMN workflow ─► compiler ─► definition (Solana account, by hash)
                                                              │
                                     flow_engine (one Anchor program) runs every issuance
                                                              ▲ on_report (forwarder CPI)
Chainlink feed (ETH, BTC, SOL) ─► CRE notes-keeper ─► keystone forwarder
```

- `solana/programs/flow_engine`: the engine (Anchor 0.31.1), deployed on devnet at `9a5xpgRgK7NQMVtYvLuVq1XooK3Ca4CrKVkFEnVRGaHx`.
- `packages/flow`: BPMN parser and builder, expression language, compiler and Borsh codec, structured products and their reference payoff, validator, AI pipeline (Cloudflare Workers AI: Clef routes and checks required terms, Kimi K2.6 extracts and edits), keeper logic, client.
- `cre/notes-keeper`: the CRE workflow (TypeScript, `@chainlink/cre-sdk` 1.23).
- `app`: marketplace, offering pages, issue form, studio, portfolio; a Cloudflare Worker with the AI endpoint and the test-USDC faucet.

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

**Tests.**
- `npm run e2e`: all five products along six price paths on a local validator,
  two investors each, one partial transfer mid-life; every payout equals the
  reference payoff and is withdrawn as SPL USDC; every CRE report under 300k
  compute units.
- Unit tests: every product round-trips BPMN → IR → definition → bytes, and
  BPMN → draft → BPMN; the AI pipeline (clarify instead of guess, coupon
  conversion, unsupported underlyings refused, validator-driven repair of edits).
- The CRE workflow compiles with the official `cre-compile`; the app was
  checked in a headless browser.

**AI, against the live models.** A full phoenix term sheet becomes the right
parameters in about 7 seconds (10% p.a. quarterly → 2.5% per period); a request
missing terms gets a question back; "pay the paying agent a 0.1% fee after each
coupon" and "investors get an extra 1% when it autocalls" come back as correct,
validated workflow changes.

## Honest limits

- CRE runs in Chainlink's simulator with `--broadcast` (real devnet writes
  through Chainlink's simulator forwarder) until deploy access is granted; the
  engine already accepts the staging DON forwarder.
- Note units live in the engine's ledger: transferable in whole or in part,
  but not SPL tokens yet, so wallets and DEXs do not show them.
- Cash settlement only; up to about 30 investors and 12 observations per
  issuance.
- Data is public on Solana; Flow's Canton target keeps it private.
- Minute-apart observations often see the same price: ETH/USD and BTC/USD
  update hourly or on a 0.5% move, SOL/USD daily.

## What's next

- `cre workflow deploy` to the DON and CRE log triggers on the engine's events.
- Note units as SPL tokens (Token-2022 with the engine as permanent delegate)
  for wallet visibility and secondary markets; physical settlement.
- Per-offering investor allowlists, and Flow's Canton target for private
  institutional issuance from the same BPMN.
