# Demo script (4½ minutes)

A note's life takes longer than a pitch, so one worst-of note is started
before you present and its strikes land while you talk. A second is issued
live from a template, and a finished one proves the payouts.

## Before you present (an hour ahead)

1. **Keeper running.** `pm2 status stratosnotes-keeper` shows `online` (start
   it with `pm2 start scripts/keeper-loop.sh --name stratosnotes-keeper --interpreter bash`).
   It runs the CRE workflow every minute and broadcasts to devnet.
2. **A worst-of note in flight, with room for an Ethereum investor.** About 60
   minutes before the talk, issue one whose strike lands about 3 minutes into
   it (STRIKE_IN = seconds until then), leaving 300 units unsold:
   ```bash
   cd packages/flow
   STRIKE_IN=3780 OBS_EVERY=120 EXTRA_UNITS=300 npx tsx scripts/devnet.ts issue worst-of
   ```
   Note the `process` address it prints; two demo investors are already
   subscribed. (`issue phoenix` gives a single-asset note instead.)
3. **An Ethereum investor (at least 45 minutes before the strike).** Open the
   note in a browser with MetaMask on **Sepolia** (a little Sepolia ETH), press
   **Get test USD on Sepolia**, then subscribe 300 units in **Subscribe from
   Ethereum Sepolia**. CCIP delivers it in 35-40 minutes; the
   `stratosnotes-ccip-relayer` (pm2) re-executes it if Chainlink's executor
   cannot. Check it landed: the **Holders** table shows the `0x…` address with
   300 units, tagged Sepolia.
4. **Wallet.** Phantom (or Solflare) on **devnet**, with ~0.2 devnet SOL
   (faucet.solana.com). In the app, press **Test USDC** in the top bar once.
5. **Tabs, in order:**
   1. Marketplace: https://sp.stratoslab.app/app
   2. The in-flight note: `https://sp.stratoslab.app/app/note/<process>`
   3. Issue workspace: https://sp.stratoslab.app/app/issue
   4. The finished worst-of note: https://sp.stratoslab.app/app/note/3o6EuEWkQ6now9b5TEd85BUEdQGeQfHGotDuLP1LPkUj
   5. Terminal: `pm2 logs stratosnotes-keeper --lines 0`
   6. Solana Explorer (devnet), ready to paste a transaction.
   7. Sepolia Etherscan on the Ethereum investor's address, **Tokens** tab.

## The talk

**0:00 The problem (20 s).** "A structured note is a promise about dates and
prices. Today a bank's calculation agent watches the dates and a paying agent
moves the money. StratosNotes is a self-service issuance engine and marketplace:
the workflow runs on Solana and Chainlink CRE is the calculation agent."

**0:20 Marketplace (30 s).** Tab 1. "Every note here is read straight from
Solana: open books, live notes, and with **Redeemed** selected, the finished
ones." Toggle **Redeemed** on and off, filter by underlying. Open the in-flight
note (tab 2): the term sheet, the three underlyings with their feeds, the
schedule set at pre-trade, and the BPMN workflow with its current step
highlighted. "Its book closes in about two minutes, and this page updates
by itself when anything happens."

**0:50 Subscribe (30 s).** Enter 200 units, **Subscribe**, approve in the
wallet. "One transaction: my USDC for note units, atomically." The position
card appears with a **Transfer** form: "units can be sold on, in whole or in
part; later coupons follow them."

**1:20 An investor on Ethereum (20 s).** Point at **Holders**: the `0x…`
address tagged Sepolia with 300 units. "This investor never touched Solana:
they paid in tUSD on Ethereum Sepolia, and Chainlink CCIP carried the tokens
and the subscription to the note. Their coupons go back the same way."

**1:40 Issue from a template (40 s).** Tab 3, the Issue workspace. "An issuer
starts from a template, a term sheet, the AI or a blank canvas." Under
**Published templates**, open **12M Phoenix on BTC with servicing fee**. "This
template was designed in this workspace and saved to the library: a phoenix
where the issuer pays the paying agent a fee with each coupon. It is a workflow,
so the fee is on the canvas," and point at a **Pay Coupon … + Servicing Fee** step.
It opens on **Issue**: size, strike in 5 minutes, observations every 3 minutes,
the reserve. "Publish, and the book opens on the marketplace." (Publish only
if time allows; it takes two wallet approvals and the issuer's test USDC.)

**2:20 Design with AI (40 s).** Press **Templates**, then **AI**, and type:
> 12 month phoenix on the worst of ETH and BTC, 10% p.a. paid quarterly, 70% coupon barrier with memory, autocall at 100% from the second quarter, knock-in 60%

"10% a year becomes 2.5% a quarter, and two underlyings make a worst-of
basket." Press **Open workflow** in the dialog, then show **Payoff** (the
reference payoff and the what-if) and **Template**: "save it, and every issuer
can issue it."

**3:00 CRE fixes the strikes (40 s).** Tab 5: the keeper log shows
`<process> Task_FixStrike [three prices] -> written` for the in-flight note
(prices in 10-decimal fixed point). "That's the
CRE workflow: it found the strike was due, read three Chainlink feeds at the
finalized block, and wrote one signed report through Chainlink's forwarder."
Back on tab 2, without refreshing: three strikes, the book closed, the
highlight on the first observation. Paste the transaction into the explorer if
asked: the forwarder program calls the engine's `OnReport`.

**3:40 It pays, on both chains (40 s).** Tab 4, the finished worst-of note: "This one ran its
whole life with nobody touching it after issuance. CRE fixed three strikes,
observed twice, the worst performer stayed above every barrier, it paid two
coupons and autocalled: 636 and 424 USDC for 600 and 400 units, exactly the
reference payoff." If the in-flight note has autocalled by now, go back to it:
in **Holders**, press **Send** next to the Sepolia investor's tUSD (your Solana
wallet pays the CCIP fee) and switch to tab 7: the payout lands on Ethereum in
about a minute.

**4:20 Close (10 s).** "One Solana program runs every note as a BPMN workflow;
one CRE workflow observes them all; anyone can issue from the library. The
link is in the submission."

## If something goes wrong

- **Strikes not written yet:** CRE reads at the finalized block, so a report
  lands about a minute after its time. Show tab 4 first and come back.
- **AI slow or busy:** open **12M Worst-of Phoenix on ETH, BTC, SOL** under
  Products instead, then edit a gateway condition by hand (select the flow,
  change the condition); **Validate** updates live.
- **No templates listed:** reseed with `npx tsx scripts/seed-templates.ts` in
  `packages/flow` (about a minute; devnet RPC may rate-limit, rerun with
  `ONLY=<part of a name>` for any it missed).
- **Wallet has no USDC:** press **Test USDC** (once per 10 minutes per wallet).
- **Page not updating:** it re-reads every 20 seconds even if the live
  connection drops; a refresh shows the latest at once.
- **Explorer slow:** the keeper log line already shows the result.
- **Sepolia subscription not landed:** CCIP inbound takes 35-40 minutes;
  `pm2 logs stratosnotes-ccip-relayer` shows any manual re-execution. If it
  missed the book, the tUSD is credited back to the investor (Send returns it
  to Sepolia). The finished cross-chain note is
  `DFaUHwaGgwWkFAcQ74ZQ9cVGRMisCG4jg67ywFHVQxJm` (300 units from Sepolia, 306
  tUSD sent home).
