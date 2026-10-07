# CRE evidence

StratosNotes' CRE workflow, [`cre/notes-keeper`](../cre/notes-keeper), runs through the CRE CLI's simulator.
`--broadcast` sends its reports to Solana devnet through Chainlink's simulator forwarder, so every report below
is a real devnet transaction. The workflow is not yet deployed to the CRE network: deployment access has been
requested (`cre account access`).

- CRE CLI v1.36.0, `@chainlink/cre-sdk` 1.23
- The keeper runs every minute under pm2 ([`scripts/keeper-loop.sh`](../scripts/keeper-loop.sh)):
  ```bash
  cre workflow simulate ./notes-keeper --target simulation-settings --trigger-index 0 --non-interactive --broadcast
  ```

## 1. A note's whole life, written by CRE (the note in the demo video)

The worst-of phoenix on ETH and BTC [`5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV`](https://explorer.solana.com/address/5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV?cluster=devnet)
was issued and subscribed from the app on 7 October 2026. After that, CRE was the only thing that acted on it.

Keeper output (the CLI's `[USER LOG]` lines and the workflow result):

```
2026-10-07T11:43:49Z [USER LOG] due oracle steps: 1, payouts to other chains: 0
2026-10-07T11:43:51Z [USER LOG] 5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV Task_FixStrike [25811500000000,837418331461100] -> written
"{\"due\":1,\"payouts\":0,\"written\":[\"5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV:Task_FixStrike\"]}"
2026-10-07T11:46:49Z [USER LOG] due oracle steps: 1, payouts to other chains: 0
2026-10-07T11:46:51Z [USER LOG] 5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV Task_Observe1 [25811500000000,837418331461100] -> written
"{\"due\":1,\"payouts\":0,\"written\":[\"5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV:Task_Observe1\"]}"
2026-10-07T11:49:50Z [USER LOG] due oracle steps: 1, payouts to other chains: 0
2026-10-07T11:49:51Z [USER LOG] 5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV Task_Observe2 [25811500000000,837418331461100] -> written
"{\"due\":1,\"payouts\":0,\"written\":[\"5FrLk7k7zsGjNXJLeSH8oG43UnGXyrpVVPVty5SXYphV:Task_Observe2\"]}"
```

Prices are the Chainlink ETH/USD and BTC/USD feeds (8 decimals): ETH 2,581.15 and BTC 83,741.83, the strikes shown in
the video. Each report is one devnet transaction: the forwarder's `Report` instruction verifies the report, and its
CPI into the engine's `OnReport` runs the step.

| Report | Devnet transaction | Result on-chain |
|---|---|---|
| Fix strike | [`MtPdEvQV…F6QWpyV`](https://explorer.solana.com/tx/MtPdEvQVi8cn1NZsJ6XG4ghNZy5KQDhMFKKtdhTwHWnTzdjhEPexpwDaRLvD25iVXgLtsggXRQHX2m1oF6QWpyV?cluster=devnet) | Strikes set, book closed |
| Observation 1 | [`39Czvwhe…jbjthA1`](https://explorer.solana.com/tx/39Czvwhe712qsyq3dvzYCffuuMn3HWm1iKfJXTT5AkqqmXbVhABwjXLXUVoWr6dwnktxgDevjSFKfeDndjbjthA1?cluster=devnet) | Worst-of 100%: 2.5% coupon |
| Observation 2 | [`21tvFDMS…9Wa9Hyp`](https://explorer.solana.com/tx/21tvFDMSX2786yVrnvWEbGCfwCAtuobp8PZFkpEmCom5E5tvb99NXTRHS2x36HGJR5ChD8C46fBFBVQTr9Wa9Hyp?cluster=devnet) | Coupon, autocall, redemption: 105 USDC for 100 |

## 2. A CRE CLI run, verbatim

One run of the same command without `--broadcast`, captured 7 October 2026 at 14:23 UTC. No note had a step due
at that moment. Hashes are shortened.

```
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s | Consensus obs=25kb | ChainWrite evm_report=50kb evm_gas=10000000 solana_report=265b solana_cu=300000 | WASM binary=100mb compressed=20mb
2026-10-07T14:23:59Z [SIMULATION] Simulator Initialized

2026-10-07T14:23:59Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-10-07T14:23:59Z [USER LOG] due oracle steps: 0, payouts to other chains: 0

✓ Workflow Simulation Result:
"{\"due\":0,\"payouts\":0,\"written\":[]}"

2026-10-07T14:23:59Z [SIMULATION] Execution finished signal received

Simulation complete! Ready to deploy your workflow?
Run cre account access to request deployment access.
```

## 3. More CRE-written lifecycles and payouts

- **Phoenix on ETH** `8SvcVvQ8…` and **worst-of on ETH, BTC, SOL** `3o6EuEWk…`: every strike and observation
  report, with transactions and compute units, is in [SUBMISSION.md](SUBMISSION.md#evidence-devnet-and-sepolia).
  The largest report used 99,231 compute units, under CRE's 300k Solana cap.
- **CRE as paying agent on Ethereum:** payout reports lock a Sepolia holder's coupon, redemption or delivered
  token for CCIP. The keeper log of the physically settled note `CviXTYq7…` shows:
  ```
  2026-10-07T09:29:43Z [USER LOG] CviXTYq7RJPy7rt5Nw5riHcJXvpSqW8DNByhL9sd4d4C payout asset 2 to 4uQeVj5tqViQh7yYT7dNgiw6c75JAHvbDHhNcqSpQTZ (382464700) -> locked for CCIP
  ```
  That is 0.03824647 tETH for the Sepolia holder (`4uQeVj…` is how the engine stores the address `0x8ba8…2568`), delivered over CCIP.
  The transactions are in [crosschain.md](crosschain.md).
