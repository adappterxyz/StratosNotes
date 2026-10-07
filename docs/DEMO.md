# Demo script (4½ minutes)

A note's life takes longer than a pitch, and a subscription from Ethereum
takes 35-40 minutes to land. So: a worst-of note with an Ethereum investor is
started an hour before you present and its strikes land while you talk; a
second note is issued live from a template; finished notes prove the payouts
on both chains.

## Before you present

**An hour ahead**

1. **Bots running.** `pm2 status` shows these `online` (start commands in
   brackets, from the repo root):
   - `stratosnotes-keeper`: the CRE workflow every minute
     (`pm2 start scripts/keeper-loop.sh --name stratosnotes-keeper --interpreter bash`);
   - `stratosnotes-ccip-relayer`: delivers Ethereum subscriptions the CCIP
     executor could not (`pm2 start scripts/ccip-relayer.sh --name stratosnotes-ccip-relayer --interpreter bash`);
   - `stratosnotes-ccip-payouts`: delivers the payouts CRE locks
     (`pm2 start "npx tsx scripts/ccip-payouts.ts" --name stratosnotes-ccip-payouts --cwd packages/flow`).
2. **A worst-of note in flight, with room for an Ethereum investor.** Issue one
   whose strike lands about 3 minutes into the talk (`STRIKE_IN` = seconds
   from now), leaving 300 units unsold:
   ```bash
   cd packages/flow
   STRIKE_IN=3780 OBS_EVERY=120 EXTRA_UNITS=300 npx tsx scripts/devnet.ts issue worst-of
   ```
   Note the `process` address; two Solana demo investors are already in.
3. **The Ethereum investor (at least 45 minutes before the strike).** Open the
   note with MetaMask on **Sepolia** (a little Sepolia ETH), press **Get test
   USD on Sepolia**, and subscribe 300 units in **Subscribe from Ethereum
   Sepolia**. The card tracks it ("waiting for Ethereum finality",
   "committed", "delivered").

**Ten minutes ahead**

4. Check the note's **Holders** card: the `0x…` address, tagged Sepolia, with
   300 units.
5. **Wallets.** Phantom (or Solflare) on **devnet** with ~0.2 devnet SOL
   (faucet.solana.com); press **Test USDC** in the top bar once.
6. **Tabs, in order:**
   1. Marketplace: https://sp.stratoslab.app/app
   2. The in-flight note: `https://sp.stratoslab.app/app/note/<process>`
   3. Issue workspace: https://sp.stratoslab.app/app/issue
   4. The finished worst-of note: https://sp.stratoslab.app/app/note/3o6EuEWkQ6now9b5TEd85BUEdQGeQfHGotDuLP1LPkUj
   5. Terminal: `pm2 logs stratosnotes-keeper --lines 0`
   6. Sepolia Etherscan, the Ethereum investor's address, **Token holdings**
      (shows the tUSD and tETH it was paid; for the demo key:
      https://sepolia.etherscan.io/address/0x8ba8251a96a503363641e5e36f5a839bdad82568)
   7. The landing page's **Cross-chain** section: https://sp.stratoslab.app/#crosschain

## The talk

**0:00 The problem (20 s).** "A structured note is a promise about dates and
prices. Today a bank's calculation agent watches the dates and a paying agent
moves the money, and you can only buy the note where the bank is.
StratosNotes is a self-service issuance engine and marketplace: the note runs
on Solana, Chainlink CRE is the calculation and paying agent, and investors
can be on Solana or Ethereum."

**0:20 Marketplace (30 s).** Tab 1. "Every note here is read straight from
Solana." Toggle **Redeemed**, filter by underlying. Open the in-flight note
(tab 2): the three underlyings and their feeds, the schedule set at pre-trade,
the BPMN workflow with its current step highlighted. "This page updates by
itself when anything happens on-chain."

**0:50 Investors on both chains (40 s).** Subscribe 200 units, approve in the
wallet: "one transaction, my USDC for note units." Point at **Holders**: "And
this investor never touched Solana. They paid tUSD on Ethereum; Chainlink CCIP
carried it and their subscription to the note, and the engine holds 300 units
for their Ethereum address." Point at the **Subscribe from Ethereum Sepolia**
card: "anyone with MetaMask can do the same."

**1:30 Issue from a template (40 s).** Tab 3. Under **Published templates**,
open **12M Phoenix on BTC with servicing fee**: "designed in this workspace and
saved to the library; the fee is a step on the canvas." It opens on **Issue**:
size, strike in 5 minutes, observations every 3 minutes, the reserve. "Publish,
and the book opens on the marketplace." (Publish only if time allows: two
wallet approvals.)

**2:10 Design with AI (40 s).** **Templates**, then **AI**:
> 12 month phoenix on the worst of ETH and BTC, 10% p.a. paid quarterly, 70% coupon barrier with memory, autocall at 100% from the second quarter, knock-in 60%, physical delivery

"10% a year becomes 2.5% a quarter, two underlyings make a worst-of basket."
In the dialog, show **Settlement below the barrier: Physical delivery**: "below
the knock-in, holders get the worst performer's token, on whichever chain they
hold." **Open workflow**, show **Payoff**, then **Template**.

**2:50 CRE fixes the strikes (40 s).** Tab 5: `<process> Task_FixStrike [three
prices] -> written`. "CRE found the strike was due, read three Chainlink feeds
at the finalized block, and wrote one signed report through Chainlink's
forwarder." Back on tab 2, without refreshing: three strikes, the book closed,
the highlight on the first observation.

**3:30 It pays, on both chains (40 s).** Tab 4: "this note ran its whole life
with nobody touching it: three strikes, two observations, two coupons, an
autocall; 636 and 424 USDC, exactly the reference payoff." Tab 6: "and these
are payouts to an Ethereum investor from notes on Solana: tUSD coupons and
redemptions, and tETH from a physically settled note that knocked in. For
each one CRE wrote a signed payout report, the engine locked the amount, and a
relay sent it over CCIP. Nobody pressed a button." Tab 7 if there is time: the
cross-chain flow in one picture.

**4:10 Close (20 s).** "One Solana program runs every note as a BPMN workflow;
one CRE workflow observes them all and pays holders on Solana and Ethereum;
CCIP moves the money; anyone can issue from the library. The link is in the
submission."

## If something goes wrong

- **Strikes not written yet:** CRE reads at the finalized block, so a report
  lands about a minute after its time. Show tab 4 and 6 first, then come back.
- **Ethereum subscription not landed:** inbound CCIP takes 35-40 minutes;
  `pm2 logs stratosnotes-ccip-relayer` shows any re-execution. If it missed
  the book, the tUSD is credited back and CRE pays it home automatically.
  Fall back to the finished cross-chain note
  `DFaUHwaGgwWkFAcQ74ZQ9cVGRMisCG4jg67ywFHVQxJm` (300 units subscribed from
  Sepolia, 306 tUSD paid back).
- **Payout to Ethereum slow:** devnet's public RPC rate-limits the bots; the
  relay retries every 30 s. The note's **Holders** card lists payouts on their
  way; **Send now** delivers one at once.
- **AI slow or busy:** open **12M Worst-of Phoenix on ETH, BTC, SOL** under
  Products and set **Physical delivery** in the term sheet by hand.
- **No templates listed:** `npx tsx scripts/seed-templates.ts` in
  `packages/flow` (rerun with `ONLY=<part of a name>` for any it missed).
- **Wallet has no USDC:** **Test USDC** in the top bar (once per 10 minutes).
- **Page not updating:** it re-reads every 20 seconds even if the live
  connection drops; a refresh shows the latest at once.
