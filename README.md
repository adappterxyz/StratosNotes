# StratosNotes

Self-service structured product issuance and marketplace on **Solana**, with
the note lifecycle driven by **Chainlink CRE**. Built for TOKEN2049 Origins
(Best Use of Solana; Best Workflow with CRE).

Issuers configure a note from a term sheet (fixed coupon note, reverse
convertible, phoenix with memory, snowball, principal-protected note). The
product becomes a BPMN workflow (Issuer, Paying Agent, Investor), compiled to
a definition that a single on-chain workflow engine runs. Investors subscribe
in USDC from the marketplace; Chainlink CRE fixes the strike and observes the
underlying from Chainlink price feeds on each date; coupons, autocalls and
redemptions pay out on-chain.

The design is a rewrite of [Flow](https://flow.stratoslab.app)'s BPMN compiler
and payoff engines for Solana.

| Path | What |
|---|---|
| `solana/programs/flow_engine` | Anchor program: runs compiled BPMN workflows (token multiset, gateways with predicates, timers, open roles, subscription windows, internal ledger + SPL cash vault), receives CRE reports through the keystone forwarder |
| `solana/programs/mock_forwarder` | Test stand-in for the keystone forwarder (same CPI shape) |
| `packages/flow` | BPMN parser/builder, expression language, compiler to the engine format, structured products, reference payoff, client |
| `scripts/e2e.sh` | Every product end to end on a local validator, checked against the reference payoff |

```bash
npm install
npm run build:programs     # anchor build (Anchor 0.31.1)
npm test                   # compiler + products unit tests
npm run e2e                # local validator: issue, subscribe, observe, redeem, withdraw
```
