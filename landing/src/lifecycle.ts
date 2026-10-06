// One structured note's lifecycle, step by step, and what each step is on
// each ledger. Snippets are taken from the real code: the StratosNotes Solana
// engine and CRE keeper, and Flow's generated Daml (Canton) and Solidity (EVM).

export type Chain = 'solana' | 'canton' | 'evm';

export interface LifecycleStep {
  id: string;
  type: 'event' | 'box' | 'gateway' | 'end';
  x: number;
  y: number;
  label: string;
  tag: string;
  title: string;
  desc: string;
  /** Who makes it happen. */
  actor: string;
  code: Record<Chain, string>;
}

const c = (s: string) => `<span class="cm">${s}</span>`;
const k = (s: string) => `<span class="kw">${s}</span>`;
const t = (s: string) => `<span class="ty">${s}</span>`;
const f = (s: string) => `<span class="fn">${s}</span>`;
const q = (s: string) => `<span class="st">${s}</span>`;

export const STEPS: LifecycleStep[] = [
  {
    id: 'terms', type: 'event', x: 8, y: 50, label: 'Term sheet',
    tag: 'Pre-trade · Issuer', title: 'Approve Terms', actor: 'Issuer',
    desc: 'Size, strike date and observation dates are set per issuance, not when the product is designed. The coupon reserve is deposited in the same step.',
    code: {
      solana: `${c('// flow_engine: the Issuer runs its user task')}
engine.${f('executeStep')}(process, definition, Task_ApproveTerms, [
  isin, notional, strikeDate,
  obsDate1, obsDate2, obsDate3, obsDate4,
  reserve,
], { deposit: { asset: ${q('USDC')}, mint } })
${c('// captures the fields, then the deposit op moves')}
${c('// `reserve` USDC into the issuance\'s vault (PDA)')}`,
      canton: `${c('-- Flow → Daml (generated): the Issuer approves this issuance')}
${k('choice')} ${f('ApproveTerms')} : ${t('ContractId')} ${t('IssuerProcess')}
  ${k('with')}
    isin_input : ${t('Text')}
    termSheetRef_input : ${t('Text')}
    notional_input : ${t('Decimal')}
    obsDate1_input : ${t('Date')}   ${c('-- … obsDate4_input')}
  ${k('controller')} issuer
  ${k('do')}
    ${k('assert')} (elem ${q('"Task_ApproveTerms"')} activeStates)
    ${k('create')} ${k('this')} ${k('with')} ...`,
      evm: `${c('// Flow → Solidity: each issuance deploys with its own schedule')}
${k('constructor')}(..., ${t('uint256')}[4] ${k('memory')} times_) {
  ${k('for')} (${t('uint256')} i; i < 4; i++) {
    ${f('require')}(times_[i] > (i == 0 ? block.timestamp : times_[i - 1]),
      ${q('"schedule must be in the future and increasing"')});
    obsTimes[i] = times_[i];
  }
}`,
    },
  },
  {
    id: 'book', type: 'box', x: 25, y: 26, label: 'Subscribe',
    tag: 'Open book · Investors', title: 'Subscribe (DvP)', actor: 'Any investor',
    desc: 'Anyone subscribes until the strike date. Each subscription swaps stablecoins for note units atomically; units can later be transferred in whole or in part.',
    code: {
      solana: `${c('// An OPEN role: anyone may run it, again and again,')}
${c('// until the strike date (a repeatable window)')}
Task_Subscribe: until = strikeDate
  ops = [
    ${f('deposit')}(USDC, units * ${q('100 / 100')}),            ${c('// signer → vault')}
    ${f('swap')}(note: Issuer → Investor, units,
         USDC: Investor → Issuer, units * ${q('100 / 100')}),
  ]
${c('// later: transfer_units(note, to, amount) — whole or part')}`,
      canton: `${c('-- Flow → Daml (generated): delivery-versus-payment')}
${k('choice')} ${f('SettleSubscriptionDvP')} : ${t('ContractId')} ${t('PayingAgentProcess')}
  ${k('with')}
    deliveryHoldingCids : [${t('ContractId')} ${t('StructuredNoteHolding')}]
    paymentHoldingCids : [${t('ContractId')} ${t('NoteCashHolding')}]
  ${k('controller')} payingAgent
  ${k('do')}
    ${k('assert')} (elem ${q('"Task_Settle"')} activeStates)
    ${c('-- both legs settle in one transaction, or neither')}`,
      evm: `${c('// Flow → Solidity')}
${k('function')} ${f('subscribe')}(${t('uint256')} amount) ${k('external')} {
  ${f('require')}(status == Status.OFFERING, ${q('"offering closed"')});
  ${f('require')}(amount > 0 && totalSupply + amount <= MAX_UNITS * unit, ${q('"over notional"')});
  ${f('_pull')}(msg.sender, issuer, (amount * ISSUE_PRICE) / WAD);
  ${f('_mint')}(msg.sender, amount);
}`,
    },
  },
  {
    id: 'strike', type: 'box', x: 42, y: 74, label: 'Fix strike',
    tag: 'Oracle step · Chainlink CRE', title: 'Fix Strike', actor: 'Chainlink CRE',
    desc: 'On the strike date the CRE workflow reads the Chainlink price feed at the finalized block and writes a DON-signed report; the ledger accepts it only from Chainlink and within the declared bounds.',
    code: {
      solana: `${c('// cre/notes-keeper (runs on the DON)')}
${k('const')} values = d.feeds.${f('map')}(feed => ${f('readFeed')}(runtime, feed))
solana.${f('writeReport')}(runtime, {
  receiver: engine,                 ${c('// via the keystone forwarder')}
  report: runtime.${f('report')}(${f('reportPayload')}(process, Task_FixStrike, values)),
  computeConfig: { computeLimit: ${q('300000')} },
})
${c('// flow_engine::on_report: forwarder PDA checked,')}
${c('// initialLevel bounds-checked, then straight-through')}`,
      canton: `${c('-- Flow → Daml (generated): the oracle value is a choice input')}
${k('choice')} ${f('FixStrikeOracle')} : ${t('ContractId')} ${t('PayingAgentProcess')}
  ${k('with')}
    initialLevel_input : ${t('Decimal')}
  ${k('controller')} payingAgent
  ${k('do')}
    ${k('assert')} (elem ${q('"Task_FixStrike"')} activeStates)
    ${f('assertMsg')} ${q('"oracle value for initialLevel below declared bound"')} (initialLevel_input >= ${q('0.01')})
    ${f('assertMsg')} ${q('"oracle value for initialLevel above declared bound"')} (initialLevel_input <= ${q('100000.0')})`,
      evm: `${c('// Flow → Solidity: CRE (or the calc agent) fixes the strike')}
${k('function')} ${f('activate')}() ${k('external')} ${f('only')}(calcAgent) {
  ${f('require')}(status == Status.OFFERING && totalSupply > 0, ${q('"cannot activate"')});
  strike = ${f('_price')}();          ${c('// Chainlink AggregatorV3')}
  status = Status.ACTIVE;
  ${k('emit')} ${f('Activated')}(strike);
}`,
    },
  },
  {
    id: 'observe', type: 'box', x: 60, y: 26, label: 'Observe k',
    tag: 'Oracle step · Chainlink CRE', title: 'Observe on each date', actor: 'Chainlink CRE',
    desc: 'Each observation waits for its own date, set at pre-trade. One report runs the observation and everything after it that needs nobody: coupon, memory, autocall check.',
    code: {
      solana: `${c('// The same keeper, every date. The engine runs the step,')}
${c('// then straight-through processing in the same transaction:')}
Task_Observe2  timer = obsDate2, captures obs2 (oracle)
GW_Coupon2     ${k('if')} obs2 >= initialLevel * ${q('70 / 100')}
Task_Coupon2   ${f('distribute')}(USDC per unit ${q('2.5 / 100')} * (missed1 + 1))
GW_Autocall2   ${k('if')} obs2 >= initialLevel * ${q('100 / 100')}
${c('// measured on devnet: 87,593 compute units (cap 300k)')}`,
      canton: `${c('-- Flow → Daml (generated, phoenix)')}
${k('choice')} ${f('Observe1')} : ${t('ContractId')} ${t('PayingAgentProcess')}
  ${k('with')} obs1_input : ${t('Decimal')}
  ${k('controller')} payingAgent
  ${k('do')}
    ${k('assert')} (elem ${q('"Task_Observe1"')} activeStates)
    now_t <- getTime
    ${f('assertMsg')} ${q('"not due yet (obsDate1)"')} (now_t >= due_t)
    ${k('create')} ${k('this')} ${k('with')}
      activeStates = advanceToken ${q('"Task_Observe1"')} ${q('"GW_Coupon1"')} activeStates
      obs1 = ${t('Some')} obs1_input`,
      evm: `${c('// Flow → Solidity')}
${k('function')} ${f('observe')}() ${k('external')} ${f('only')}(calcAgent) ${k('returns')} (${t('bool')}) {
  ${k('uint256')} k = nextObservation;
  ${f('require')}(block.timestamp >= ${f('observationTime')}(k), ${q('"observation not due"')});
  ${k('uint256')} price = ${f('_price')}();
  nextObservation = k + 1;
  ${k('emit')} ${f('Observed')}(k + 1, price);
  ${c('// coupon, autocall and maturity rules follow')}
}`,
    },
  },
  {
    id: 'autocall', type: 'gateway', x: 77, y: 74, label: 'Autocall?',
    tag: 'Gateway · predicate', title: 'Autocall check', actor: 'The ledger',
    desc: 'A gateway with a price predicate. The ledger evaluates it in exact decimal arithmetic; nobody chooses the branch, so nobody can choose the wrong one.',
    code: {
      solana: `${c('// BPMN exclusive gateway → engine predicate (RPN, i128 fixed point)')}
GW_Autocall2:
  Autocall  ${k('when')} obs2 >= initialLevel * ${q('100 / 100')}
  Continue  ${k('default')}
${c('// a branch is taken only when its fields are set;')}
${c('// a person may never override a conditioned gateway')}`,
      canton: `${c('-- Flow → Daml (generated): the branch asserts its predicate')}
${k('choice')} ${f('AutocallAt2_Autocall')} : ${t('ContractId')} ${t('PayingAgentProcess')}
  ${k('controller')} payingAgent
  ${k('do')}
    ${k('assert')} (elem ${q('"GW_Autocall2"')} activeStates)
    ${c('-- branch condition: obs2 >= initialLevel * 100 / 100')}
    initialLevel_pv <- ${k('case')} initialLevel ${k('of')} ...
    obs2_pv <- ${k('case')} obs2 ${k('of')} ...`,
      evm: `${c('// Flow → Solidity (generated, inside observe)')}
${k('if')} (period < N_OBS && period >= AUTOCALL_FROM && price * WAD >= strike * AUTOCALL) {
  redemptionPerUnit = WAD;
  status = Status.CALLED;
  ${k('emit')} ${f('Autocalled')}(period, price, redemptionPerUnit);
  ${k('return')} ${k('true')};
}`,
    },
  },
  {
    id: 'redeem', type: 'end', x: 93, y: 50, label: 'Redeem',
    tag: 'Settlement · every holder', title: 'Redeem and withdraw', actor: 'Holders',
    desc: 'Every holder of the note is paid units × per-unit amount, complete by construction, and the units are retired. Holders withdraw stablecoins when they like.',
    code: {
      solana: `${c('// distribute + retire: every holder in the ledger')}
Task_Autocall2   ${f('distribute')}(USDC per unit ${q('1')}, retire)
${c('// then, by each holder:')}
engine.${f('withdraw')}(process, definition, USDC, mint, owed)
${c('// devnet: 500 / 400 / 100 units → 525 / 420 / 105 USDC')}`,
      canton: `${c('-- Flow → Daml (generated): every holder, proven complete')}
${k('choice')} ${f('AutocallRedeemAllHolders')} : ${t('ContractId')} ${t('PayingAgentProcess')}
  ${k('with')}
    holderHoldingCids : [${t('ContractId')} ${t('StructuredNoteHolding')}]
  ${k('controller')} payingAgent
  ${k('do')}
    ${k('assert')} (elem ${q('"Task_Autocall2"')} activeStates)
    supply_v <- ${k('case')} notional ${k('of')} ...
    ${c('-- no duplicates; sum of units == supply')}`,
      evm: `${c('// Flow → Solidity')}
${k('function')} ${f('redeem')}() ${k('external')} {
  ${f('require')}(status == Status.CALLED || status == Status.MATURED, ${q('"not redeemable"')});
  ${f('_checkpoint')}(msg.sender);   ${c('// coupons owed first')}
  ${c('// burn the holder\'s notes, pay coupons + redemption')}
}`,
    },
  },
];

export const EDGES: Array<[string, string]> = [['terms', 'book'], ['book', 'strike'], ['strike', 'observe'], ['observe', 'autocall'], ['autocall', 'redeem']];
