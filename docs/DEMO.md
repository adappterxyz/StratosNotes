# Demo script (4 minutes)

A note's life takes longer than a pitch, so one note is started before you
present and its strike lands while you talk; a second is designed and issued
live; a finished one proves the payouts.

## Before you present (15 minutes ahead)

1. **Keeper running.** `pm2 status stratosnotes-keeper` shows `online` (start
   it with `pm2 start scripts/keeper-loop.sh --name stratosnotes-keeper --interpreter bash`).
   It runs the CRE workflow every minute and broadcasts to devnet.
2. **A note in flight.** Issue one whose strike lands about 3 minutes into the
   talk:
   ```bash
   cd packages/flow
   STRIKE_IN=720 OBS_EVERY=120 npx tsx scripts/devnet.ts issue phoenix
   ```
   Note the `process` address it prints; two demo investors are already subscribed.
3. **Wallet.** Phantom (or Solflare) on **devnet**, with ~0.2 devnet SOL
   (faucet.solana.com). In the app, press **Get test USDC** once.
4. **Tabs, in order:**
   1. Marketplace: https://sp.stratoslab.app/app
   2. The in-flight note: `https://sp.stratoslab.app/app/note/<process>`
   3. Issue workspace: `https://sp.stratoslab.app/app/issue`
   4. The finished phoenix: `https://sp.stratoslab.app/app/note/8SvcVvQ8vYAtVdLs4gF3Rc1MNybqWh2kFfPCTpD1heGG`
   5. Terminal: `pm2 logs stratosnotes-keeper --lines 0`
   6. Solana Explorer (devnet), ready to paste a transaction.

## The talk

**0:00 The problem (20 s).** "A structured note is a promise about dates and
prices. Today a bank's calculation agent watches the dates and a paying agent
moves the money. Here, the workflow runs on Solana and Chainlink CRE is the
calculation agent."

**0:20 Marketplace (30 s).** Tab 1. "Every offering here is read straight from
Solana." Open the in-flight note (tab 2): term sheet, payout chart, the
schedule set at pre-trade, and the BPMN workflow with the step it is on
highlighted. "Its book closes in about two minutes."

**0:50 Subscribe (30 s).** Enter 200 units, **Subscribe**, approve in the
wallet. "One transaction: my USDC for note units, atomically." The position
card appears with a **Transfer** form: "units can be sold on, in whole or in
part; later coupons follow them."

**1:20 Design with AI (60 s).** Tab 3, the Issue workspace. Open **AI** and type:
> 12 month phoenix on the worst of ETH and BTC, 10% p.a. paid quarterly, 70% coupon barrier with memory, autocall at 100% from the second quarter, knock-in 60%

"It extracts the terms (10% a year becomes 2.5% a quarter, two underlyings
make a worst-of basket) and asks if anything is missing." Review the term
sheet in the dialog and press **Open workflow**: each observation reads both
feeds in one CRE report and tests the worst performer. Then:
> pay the paying agent a 0.1% servicing fee after each coupon

"The change comes back as a patch, highlighted, and passes the validator and
compiler before it can be issued." Point at **Validate** (no errors) and the
**Edited: custom workflow** badge in Overview, then **Template**: "saved
designs go into a library any issuer can issue from." Finish on **Issue**:
size, strike in 5 minutes, observations every 3 minutes.

**2:20 CRE fixes the strike (60 s).** Tab 5: the keeper log shows
`Task_FixStrike … -> written` for the in-flight note. "That's the CRE workflow:
it found the strike was due, read ETH/USD from Chainlink at the finalized
block, and wrote a signed report through Chainlink's forwarder." Paste the
transaction into the explorer: the forwarder program calls the engine's
`OnReport`. Back on tab 2 (it updates live, as the account changes): the strike appears, the
book is closed, the highlight has moved to the first observation.

**3:20 It pays (30 s).** Tab 4, the finished phoenix: "This one ran its whole
life with nobody touching it after issuance: CRE fixed the strike, observed
twice, paid two coupons and autocalled. One investor had sold 100 units
mid-way; everyone was paid exactly for what they held: 525, 420 and 105 USDC."

**3:50 Close (10 s).** "One Solana program runs every note as a BPMN workflow;
one CRE workflow observes them all. Issue one yourself: the link is in the
submission."

## If something goes wrong

- **Strike not written yet:** CRE reads at the finalized block, so a report
  lands about a minute after its time. Show tab 4 first and come back.
- **AI slow or busy:** open **12M Phoenix (memory) on ETH** under Products in the Issue workspace,
  then edit a gateway condition by hand (select the flow, change the condition);
  the checks update live.
- **Wallet has no USDC:** press **Get test USDC** (once per 10 minutes per wallet).
- **Explorer slow:** the keeper log line already shows the result.
