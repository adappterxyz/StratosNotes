# Cross-chain notes: Solana devnet + Ethereum Sepolia over Chainlink CCIP

Status: live on Solana devnet and Ethereum Sepolia (2026-10-07). The lifecycle
stays on Solana; CCIP moves tokens and instructions between the two chains.

## Principles

- **One hub.** Every note's lifecycle, ledger and vaults are on Solana (the
  `flow_engine` program); Chainlink CRE stays the calculation agent.
- **Per-note setup.** What crosses chains is part of the note's term sheet and
  workflow: settlement (cash or physical delivery), the chain each asset is
  funded from, and the chain each investor uses.
- **Tokens, not IOUs.** Cash and deliverable underlyings are CCIP cross-chain
  tokens (CCT, burn-mint): the same token on both chains. A Sepolia investor's
  USDC is burned on Sepolia and minted into the note's vault on Solana; a
  payout to Sepolia is burned on Solana and minted to their address.
- **No Sepolia contract.** Investors and issuers on Sepolia send tokens plus a
  payload straight to the CCIP router; payouts arrive as plain token transfers.
  CCIP authenticates the sender, so a Sepolia holder's identity is their
  address.

## Flows

| Flow | Path |
|---|---|
| Subscribe from Sepolia | Investor → Sepolia CCIP router `ccipSend(cash + {subscribe, process, units})` → engine `ccip_receive` → tokens into the vault, the subscription step runs with the investor as a *remote holder* |
| Post a reserve from Sepolia | Issuer → `ccipSend(tokens + {deposit, process, asset})` → engine credits the issuer |
| Coupons, autocall, redemption | Unchanged: CRE reports on Solana; `distribute` credits every holder, local or remote |
| Physical delivery | Below the knock-in, gateways pick the worst performer and `distribute` its token: `1 / initialLevel_SYM` per unit, from the issuer's delivery reserve |
| Pay out to Sepolia | `withdraw_remote(process, holder, asset)` (permissionless crank; the caller funds the CCIP fee in SOL) → engine moves tokens from the vault and CPIs `ccip_send` with the holder's address as receiver |

## Engine changes

- Remote holder keys: `[chain tag (1 byte)] [11 zero bytes] [EVM address (20 bytes)]`;
  never a signer, so only CCIP messages and the engine act for them.
- `ccip_receive`: accepts calls only from an offramp the CCIP router allows
  (router `allowed_offramp` PDA + offramp `external_execution_config` signer),
  moves received tokens into the process vault and runs the requested step
  with the deposit already funded.
- `withdraw_remote`: outbound token transfer via CPI to the router's
  `ccip_send`; a system-owned engine PDA signs and pays the fee.

## Tokens (testnet)

| Token | Use | Solana devnet | Sepolia |
|---|---|---|---|
| Test USDC | cash | existing mint, mint authority moved to a 1-of-2 SPL multisig (pool signer, faucet) | BurnMintERC20 |
| tETH, tBTC, tSOL | deliverable underlyings | new mints, same multisig setup | BurnMintERC20 |

Each pair: Chainlink's BurnMint pool program on Solana devnet
(`41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB`) and a BurnMintTokenPool on
Sepolia, registered self-serve in both token admin registries.

## CCIP reference (testnet)

| | Value |
|---|---|
| Sepolia router | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` |
| Sepolia chain selector | `16015286601757825753` |
| Solana devnet router | `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C` |
| Solana devnet selector | `16423721717087811551` |
| Solana fee quoter | `FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi` |

## Spike results (2026-10-07)

| Direction | What | Fee | Latency |
|---|---|---|---|
| Solana devnet → Sepolia | data message to an EOA (`0x27c75574…`) | native SOL | **68 s**, executed (state 2) |
| Solana devnet → Sepolia | 5 tUSD token transfer over our lane (`0x90ee9220…`) | native SOL | **< 100 s**, minted on Sepolia |
| Sepolia → Solana devnet | data message to Chainlink's example receiver (`0x22a19f5c…`) | 0.000184 ETH | **~32 min**: finality 14 min, commit 15.5 min, execution 31.8 min (state 2) |
| Sepolia → Solana devnet | 5 tUSD token transfer back (`0xf1f9f586…`) | 0.000221 ETH | **21 min**, minted on Solana |

What this means for notes:

- Payouts, deliveries and anything else leaving Solana reach Sepolia in about
  a minute: minute-paced lifecycles still work for Sepolia holders.
- Anything arriving from Sepolia (a subscription, an issuer's reserve) lands
  about half an hour later. A note that takes Sepolia subscriptions keeps its
  book open at least ~45 minutes, and the app shows a Sepolia subscription as
  "in flight" until CCIP delivers it.

## Deployed (testnet)

Sepolia tokens and pools: `deployments/sepolia-tokens.json` (`evm/deploy-tokens.sh`,
`evm/configure-lanes.sh`). Solana mints, pools, multisigs and lookup tables:
`deployments/solana-tokens.json` (`scripts/cct-solana.py`). The existing test
USDC mint is now the Solana side of tUSD; its mint authority is a 1-of-2 SPL
multisig (CCIP pool signer, faucet key) and the app's faucet mints through it.

Sepolia gas note: contract code is priced far above local simulation (a
BurnMintTokenPool deployment costs ~22M gas), so deployments use explicit gas
limits.

## A full cross-chain lifecycle (devnet + Sepolia, 2026-10-07)

FCN on ETH `DFaUHwaGgwWkFAcQ74ZQ9cVGRMisCG4jg67ywFHVQxJm`, 1,500 units: 600 + 400
subscribed on Solana, 300 from Sepolia over CCIP, 200 left unsold.

| Step | Where | Transaction | Compute units |
|---|---|---|---|
| Issue (start, pre-trade terms, reserve, mandate) | Solana | `3btvqFZT…`, `VadXrteQ…` | 50,191; 91,013 |
| Two Solana subscriptions | Solana | `2eq7YyRx…`, `4TpFHMvp…` | 56,771; 57,224 |
| Sepolia investor sends 300 tUSD + Subscribe(300) | Sepolia | `0xff7248630d184bc2abe4ee9a44fed4d066f1fe340560005f8bdb50086fe271cc` | |
| CCIP DON execution: our `ccip_receive` succeeds (71,400 CU), then the offramp runs out of heap | Solana | `2daXZje4QdEeAZ7EKRi1fS5ta6CLxvujvqKswJ6HCUePb2MxAE4XgB1HJf2765XANJsojuHxRzcPDvYJhQMTjk7x` (failed) | 273,222 |
| Manual execution: 300 units for `0x8ba8…2568` | Solana | `4fPBSoWJsx2cXygsFqNyJf2wrcKZf9PEaFK5nbURzMYdYucktk1rKhvvoku2j7WyHgWdvKWqaPgy2M4uVTuFxdVd` | 271,171 (engine 71,400) |
| CRE fixes the strike | Solana | `4s79CAP2dyKMCqkhrjjpadETTSXuaZ5ib7df6bQ4XcuYfNU7wC1EQKU6BE8BoCPcniXLbPhbhQVoSey75MRjF16R` | 46,851 |
| CRE observation 1: 2% coupon, autocall, redemption | Solana | `2BMweX5DZxZ9H9Mn2tSBLdF5epoAmf8THwAbhKi6JXAhxe5wPymA2ypHS2NQXWGH2PeQTmGQCyRjw579LPgpQXqG` | 74,595 |
| `withdraw_remote`: 306 tUSD to the Sepolia investor via the router's `ccip_send` | Solana → Sepolia | `4jEafTtRiMW38eP2QDtduW1PdeVaM1H4G9QynDqXtLzYYQbp3hcX8vpubQ5mW2CQoE8K2LLRVPYUpQoBCFJFq6BB` | 317,479 |

306 tUSD arrived on Sepolia about 50 seconds after `withdraw_remote`. The
Solana investors were owed 612 and 408 tUSD; the issuer kept 94 of its
reserve; its 200 unsold units were retired without paying itself.

## The DON executor and the relayer

On the DON's `execute` path the offramp verifies the signed report, and a token
transfer plus a call to a receiver with seven accounts leaves its 32 KiB heap
too small: the engine's `ccip_receive` completes, then the offramp fails
allocating after it, and the whole transaction rolls back (message state
"failed"). The same message succeeds as a manual execution, which skips the
report verification. `scripts/ccip-relayer.sh` (pm2:
`stratosnotes-ccip-relayer`) watches the Sepolia OnRamp for messages to the
engine and manually executes any that fail, so subscriptions land without
anyone acting; inbound latency is then about 35-40 minutes.

## Automatic payouts to Sepolia: CRE decides, a relay delivers

Chainlink CRE is the paying agent for holders on other chains too. Each run of
the keeper (`cre/notes-keeper`) finds every Sepolia holder with a token
balance (a coupon, a redemption, delivered tokens, a refunded late
subscription) and writes a DON-signed **payout report**
(`step = 0xFFFE`, values = the holder and the asset). The engine debits the
holder, moves the tokens from the note's vault to its CCIP sender account and
records the payout in the **outbox** (`Outbox` PDA). Any relay then delivers it
with `flush_outbox`, which calls the CCIP router's `ccip_send` with exactly
what CRE recorded: that address, that token, that amount.

CRE cannot submit the CCIP send itself: the router needs about 40 accounts,
which only fit a transaction through address lookup tables, and CRE's Solana
writes (`WriteReportRequest`) take a plain account list. The payout report
needs 11 accounts and about 40k compute units.

The relay (`packages/flow/scripts/ccip-payouts.ts`, pm2:
`stratosnotes-ccip-payouts`) decides nothing and can be run by anyone; it tops
up the engine's CCIP sender with SOL for fees when it runs low.

Live (2026-10-07): phoenix `8DtC17ArCQiCPiGezSB1dYfViA3SAoKTE7JynGX7gHe2`; a Solana
investor transferred 100 units to the Ethereum address `0x8ba8…2568`. CRE
locked the three 2.5% coupons and the final 102.5 as they were paid (four
payout reports), the relay delivered each over CCIP, and the address's Sepolia
tUSD went from 306 to 416 (+110, the reference payoff), with nobody acting.
First delivery: locked 08:43:48, sent 08:43:57
(`2weGxh8Qcyjhj7CcAwmFqcvNpYB5uaVJ1q6AbQLpGbjaxPXt6NkSkjbdv6jakGrEEkj2mLnWFDizBBBeNHKGWW8b`);
redemption: `2C9Nn9R66qEPnQ1P2VGcyU5pdKHqXBsgGhk1LV7pHgTPwd8ti775aRmT3YmyKezs7bEvvu6auByzfRmpogfMGCZc`.
