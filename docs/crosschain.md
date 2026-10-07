# Cross-chain notes: Solana devnet + Ethereum Sepolia over Chainlink CCIP

Status: in progress (design + spike). The lifecycle stays on Solana; CCIP moves
tokens and instructions between Solana devnet and Ethereum Sepolia.

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
| Sepolia → Solana devnet | 5 tUSD token transfer back (`0xf1f9f586…`) | 0.000221 ETH | pending |

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
