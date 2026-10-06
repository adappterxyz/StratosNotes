# StratosNotes: TOKEN2049 Origins submission

**One line:** a self-service structured note desk on Solana. Anyone can issue
an autocallable or capital-protected note in minutes and sell it to anyone
with USDC, and Chainlink CRE acts as the calculation agent: it fixes the
strike, observes the underlying on every date and triggers every payout.

## Tracks

| Track | What we built for it |
|---|---|
| **Best Use of Solana** | One Anchor program (`flow_engine`) that runs BPMN workflows on-chain: a token-multiset state machine with gateways, timers, open roles, subscription windows, an internal holdings ledger with atomic DvP and distribute-to-every-holder, and a USDC vault per issuance. Five structured products run on it unchanged, each as a workflow definition stored once and reused by every issuance. |
| **Best Workflow with CRE** | `cre/notes-keeper`: one CRE workflow for every note on the platform. Cron trigger, Solana reads with DON consensus, Chainlink price feeds through the EVM capability at the finalized block, and DON-signed reports written to Solana through the keystone forwarder (`SolanaClient.writeReport`). The on-chain engine accepts prices only from Chainlink's forwarder programs and bounds-checks them. |

## The problem

A structured note is a promise about dates and prices: "if ETH is above 100%
of the strike on any quarterly date, you get par plus coupon back". Today a
bank's calculation agent watches those dates by hand, a paying agent moves the
money, and the investor trusts both. Issuing one takes weeks and a legal team.

## What StratosNotes does

1. **Issue.** Pick a payoff, set size, strike date and observation dates for
   this issuance, deposit a coupon reserve. The term sheet becomes a BPMN
   workflow (Issuer, Paying Agent, Investor) compiled to an on-chain definition.
2. **Sell.** The book opens on the marketplace. Investors subscribe with USDC
   until the strike date; each subscription is an atomic USDC-for-note DvP.
3. **Observe.** On the strike date and every observation date, the CRE keeper
   reads the Chainlink feed and writes a signed report; the engine runs the
   observation and everything after it in the same transaction: coupon,
   autocall, knock-in, redemption.
4. **Get paid.** Investors withdraw USDC whenever they like.

## Demo script (3 minutes)

1. Marketplace: live offerings read straight from Solana; open one.
2. Offering page: term sheet, payoff chart, the BPMN workflow with the note's
   current step highlighted, the schedule with CRE's observations.
3. "Get test USDC", then subscribe 500 units: one transaction, USDC for notes.
4. Issue a note: phoenix with memory on ETH, strike in 5 minutes, observe
   every 3 minutes. Publish and open the book.
5. Terminal: `cre workflow simulate ./notes-keeper --broadcast` finds the due
   strike fixing, reads ETH/USD from Chainlink, writes the report; the
   explorer shows the keystone forwarder calling `on_report`.
6. Back in the app: strike fixed; after the next run the observation lands
   and the coupon (or autocall) shows up as cash to withdraw.

## Evidence

- `npm run e2e`: every product (six price paths, two investors each) paid
  exactly its reference payoff on a local validator, withdrawn as SPL USDC.
- Devnet, driven by CRE: issuance `2eWVSt8MRqR8wMBu3ZWiWmj85YUdwzoACyyQWgT3Gu5B`
  (FCN on ETH): strike fixed and observation 1 delivered by the CRE keeper
  through Chainlink's simulator forwarder (`7kuEAA3m…`); the note autocalled;
  investors received 612 and 408 USDC for 600 and 400 units (par + 2%).
  Forwarder transaction: `5k5FskXQzEE3E6frBXEaCtJikH9oxjGHayApYHXovvVi2TaB5nfk6LnXvpo6fXXLzNHXTn3RN7AGjKwcTrEaWeDa`
  (≈58.6k compute units of CRE's 300k cap).

## What's next

- Note units as SPL tokens (secondary trading), physical settlement.
- `cre workflow deploy` to the DON (the engine already accepts the staging
  forwarder); CRE log triggers on the engine's events instead of a cron scan.
- Issuer KYC/allowlists per offering, and Flow's Canton target for private
  institutional issuance from the same BPMN.
