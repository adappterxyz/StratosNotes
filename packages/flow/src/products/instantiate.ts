/**
 * Instantiate a structured product into a BPMN workflow (Flow's
 * products/instantiate.ts, for Solana and a self-service marketplace):
 *
 *  Issuer (self-service): "Approve Terms" is the pre-trade step — this
 *    issuance's size, strike date and observation dates, plus the coupon
 *    reserve it deposits — then "Mandate Paying Agent".
 *  Paying Agent (calculation agent): issues the note, fixes the strike on the
 *    strike date and observes on each date (both oracle steps, delivered by
 *    Chainlink CRE), pays coupons, autocalls, redeems at maturity.
 *  Investor (an OPEN role: anyone): "Subscribe" is a repeatable window that
 *    closes at the strike date; each subscription deposits USDC and swaps it
 *    for note units atomically (DvP), capped by the units the issuer offered.
 *
 * Every number is an exact decimal in the generated expressions (e.g.
 * `initialLevel * 70 / 100`), evaluated on-chain in 10-decimal fixed point.
 */
import { buildWorkflow, chain, field, type BuiltWorkflow, type SpecFlow, type SpecNode } from '../bpmn';
import type { AssetDefinition, AssetOperation, NodeProps } from '../types';
import { PRODUCT_LABELS, productUses, validateProductParams, type ProductParams } from './params';

export const ISSUER = 'Issuer';
export const PA = 'Paying Agent';
export const INVESTOR = 'Investor';

export interface InstantiatedProduct extends BuiltWorkflow {
  id: string;
  name: string;
  description: string;
  params: ProductParams;
}

const num = (n: number) => {
  const s = String(n);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`unsupported number ${n}`);
  return s;
};
const pct = (n: number) => `${num(n)} / 100`;

export function instantiateProduct(p: ProductParams): InstantiatedProduct {
  const errs = validateProductParams(p);
  if (errs.length) throw new Error('Invalid product parameters: ' + errs.join(' '));
  const use = productUses(p.productType);
  const n = p.observations;

  const assets: AssetDefinition[] = [
    { id: 'note', name: 'Note', kind: 'issued' },
    { id: 'cash', name: 'USDC', kind: 'cash', decimals: 6 },
  ];
  const distribute = (perUnit: string, retire = false): AssetOperation => ({
    assetId: 'cash', operation: 'distribute',
    params: { holdingAssetId: 'note', payer: ISSUER, amountSource: 'expr', amountExpr: perUnit, ...(retire ? { retire: true } : {}) },
  });
  const oracleField = (name: string) => field(name, 'Decimal', {
    oracle: { feed: p.underlying.feed, feedChain: p.underlying.feedChain, min: num(p.underlying.minPrice), max: num(p.underlying.maxPrice), staleness: 3600 },
  });
  const obsDate = (k: number) => `obsDate${k}`;
  const issuePrice = pct(p.issuePricePct);

  // ---- Paying Agent lifecycle -------------------------------------------
  const nodes: SpecNode[] = [];
  const flows: SpecFlow[] = [];
  let fid = 0;
  const flow = (src: string, tgt: string, extra: Partial<SpecFlow> = {}) => flows.push({ id: `P_F${++fid}`, src, tgt, ...extra });
  const memory = p.productType === 'phoenix' && !!p.memory;
  const pa = (extra: NodeProps = {}): NodeProps => extra;

  nodes.push(
    { id: 'Recv_Mandate', type: 'receiveTask', name: 'Mandate Received', col: 3, props: { receiveGuard: 'notional > 0' } },
    { id: 'Task_IssueNote', type: 'serviceTask', name: 'Issue Note to Issuer', col: 4, props: { assetOperation: { assetId: 'note', operation: 'mint', params: { amountSource: 'field', amountField: 'notional', owner: ISSUER } } } },
    { id: 'Task_FixStrike', type: 'serviceTask', name: 'Fix Strike (oracle)', col: 5, props: { timer: { dateField: 'strikeDate' }, templateFields: [oracleField('initialLevel')] } },
  );
  flows.push(...chain('P_S', 'Recv_Mandate', 'Task_IssueNote', 'Task_FixStrike'));

  let col = 6;
  let prev = 'Task_FixStrike';
  let pendingDefault: Partial<SpecFlow> | undefined;
  const linkPrev = (tgt: string) => { flow(prev, tgt, pendingDefault ?? {}); pendingDefault = undefined; };
  const rate = p.couponRatePct ?? 0;
  const acFrom = p.autocallFromPeriod ?? 1;
  const redeemPerUnit = (k: number) => p.productType === 'snowball' ? `1 + ${pct(rate)} * ${k}` : '1';

  for (let k = 1; k <= n; k++) {
    const obs = `obs${k}`;
    const last = k === n;
    const obsId = `Task_Observe${k}`;
    nodes.push({ id: obsId, type: 'serviceTask', name: last ? 'Final Observation' : `Observe ${k}`, col: col++, props: pa({ timer: { dateField: obsDate(k) }, templateFields: [oracleField(obs)] }) });
    linkPrev(obsId);
    prev = obsId;

    if (p.productType === 'fcn' || p.productType === 'reverse-convertible') {
      const id = `Task_Coupon${k}`;
      nodes.push({ id, type: 'serviceTask', name: `Pay Coupon ${k}`, col: col++, props: { assetOperation: distribute(pct(rate)) } });
      linkPrev(id);
      prev = id;
    } else if (p.productType === 'phoenix') {
      const gw = `GW_Coupon${k}`, pay = `Task_Coupon${k}`, after = `Task_CouponDone${k}`;
      nodes.push({ id: gw, type: 'exclusiveGateway', name: `Coupon ${k} barrier met?`, col: col++ });
      const perUnit = memory && k > 1 ? `${pct(rate)} * (missed${k - 1} + 1)` : pct(rate);
      nodes.push({ id: pay, type: 'serviceTask', name: memory ? `Pay Coupon ${k} (with memory)` : `Pay Coupon ${k}`, col: col++, props: { assetOperation: distribute(perUnit) } });
      linkPrev(gw);
      flow(gw, pay, { name: 'Barrier met', cond: `${obs} >= initialLevel * ${pct(p.couponBarrierPct!)}` });
      if (memory) {
        const paidRec = `Task_ResetMemory${k}`, missRec = `Task_RecordMissed${k}`;
        nodes.push({ id: paidRec, type: 'serviceTask', name: 'Reset Missed Coupons', col: col++, props: { templateFields: [field(`missed${k}`, 'Decimal', { formula: '0' })] } });
        nodes.push({ id: missRec, type: 'serviceTask', name: `Record Missed Coupon ${k}`, col: col - 2, row: 1, props: { templateFields: [field(`missed${k}`, 'Decimal', { formula: k > 1 ? `missed${k - 1} + 1` : '1' })] } });
        flow(pay, paidRec);
        flow(gw, missRec, { name: 'Missed', isDefault: true });
        nodes.push({ id: after, type: 'serviceTask', name: `Coupon ${k} Settled`, col: col++ });
        flow(paidRec, after);
        flow(missRec, after);
      } else {
        nodes.push({ id: after, type: 'serviceTask', name: `Coupon ${k} Settled`, col: col++ });
        flow(pay, after);
        flow(gw, after, { name: 'Missed', isDefault: true });
      }
      prev = after;
    }

    if (use.autocall && !last && k >= acFrom) {
      const gw = `GW_Autocall${k}`, red = `Task_Autocall${k}`, end = `End_Autocalled${k}`;
      nodes.push({ id: gw, type: 'exclusiveGateway', name: `Autocall at ${k}?`, col });
      nodes.push({ id: red, type: 'serviceTask', name: 'Autocall: Redeem All Holders', col: col + 1, row: 2, props: { assetOperation: distribute(redeemPerUnit(k), true) } });
      nodes.push({ id: end, type: 'endEvent', name: `Autocalled (${k})`, col: col + 2, row: 2 });
      linkPrev(gw);
      flow(gw, red, { name: 'Autocall', cond: `${obs} >= initialLevel * ${pct(p.autocallLevelPct!)}` });
      flow(red, end);
      col++;
      prev = gw;
      pendingDefault = { name: 'Continue', isDefault: true };
    }
  }

  // ---- Maturity -----------------------------------------------------------
  const obsN = `obs${n}`;
  const end = (id: string, name: string, c: number, row = 0) => nodes.push({ id, type: 'endEvent', name, col: c, row });
  if (p.productType === 'ppn') {
    const gw = 'GW_Upside';
    nodes.push({ id: gw, type: 'exclusiveGateway', name: 'Above strike?', col });
    nodes.push({ id: 'Task_RedeemUpside', type: 'serviceTask', name: 'Redeem with Participation', col: col + 1, props: { assetOperation: distribute(`${pct(p.protectionPct!)} + ${pct(p.participationPct!)} * (${obsN} / initialLevel - 1)`, true) } });
    nodes.push({ id: 'Task_RedeemProtected', type: 'serviceTask', name: 'Redeem at Protection', col: col + 1, row: 1, props: { assetOperation: distribute(pct(p.protectionPct!), true) } });
    end('End_Upside', 'Redeemed (upside)', col + 2);
    end('End_Protected', 'Redeemed (protected)', col + 2, 1);
    linkPrev(gw);
    flow(gw, 'Task_RedeemUpside', { name: 'Above strike', cond: `${obsN} > initialLevel` });
    flow(gw, 'Task_RedeemProtected', { name: 'At or below strike', isDefault: true });
    flow('Task_RedeemUpside', 'End_Upside');
    flow('Task_RedeemProtected', 'End_Protected');
  } else {
    if (p.productType === 'snowball') {
      const gw = 'GW_FinalAutocall';
      nodes.push({ id: gw, type: 'exclusiveGateway', name: 'Called at maturity?', col: col++ });
      nodes.push({ id: 'Task_FinalAutocall', type: 'serviceTask', name: 'Redeem with Accrued Coupons', col, row: 2, props: { assetOperation: distribute(redeemPerUnit(n), true) } });
      end('End_FinalAutocall', 'Redeemed (called)', col + 1, 2);
      linkPrev(gw);
      flow(gw, 'Task_FinalAutocall', { name: 'Above autocall level', cond: `${obsN} >= initialLevel * ${pct(p.autocallLevelPct!)}` });
      flow('Task_FinalAutocall', 'End_FinalAutocall');
      prev = gw;
      pendingDefault = { name: 'Below autocall level', isDefault: true };
    }
    const gw = 'GW_KnockIn';
    nodes.push({ id: gw, type: 'exclusiveGateway', name: 'Above knock-in barrier?', col });
    nodes.push({ id: 'Task_RedeemPar', type: 'serviceTask', name: 'Redeem at Par', col: col + 1, props: { assetOperation: distribute('1', true) } });
    nodes.push({ id: 'Task_KnockIn', type: 'serviceTask', name: 'Cash-Settle Below Barrier', col: col + 1, row: 1, props: { assetOperation: distribute(`${obsN} / initialLevel`, true) } });
    end('End_Par', 'Redeemed at par', col + 2);
    end('End_KnockedIn', 'Redeemed (knocked in)', col + 2, 1);
    linkPrev(gw);
    flow(gw, 'Task_RedeemPar', { name: 'At or above barrier', cond: `${obsN} >= initialLevel * ${pct(p.knockInBarrierPct!)}` });
    flow(gw, 'Task_KnockIn', { name: 'Knocked in', isDefault: true });
    flow('Task_RedeemPar', 'End_Par');
    flow('Task_KnockIn', 'End_KnockedIn');
  }

  const label = PRODUCT_LABELS[p.productType];
  const pretrade = [
    field('isin', 'Text'),
    field('notional', 'Decimal'),
    field('strikeDate', 'Date'),
    ...Array.from({ length: n }, (_, i) => field(obsDate(i + 1), 'Date')),
    field('reserve', 'Decimal'),
  ];
  const built = buildWorkflow({
    key: 'SP',
    name: p.name,
    pools: [
      { id: 'Part_Issuer', name: ISSUER, proc: 'Proc_Issuer', nodes: [
        { id: 'Start_Issuer', type: 'startEvent', name: 'Offer Drafted', col: 0 },
        // Pre-trade: this issuance's size, dates and coupon reserve (deposited now).
        { id: 'Task_ApproveTerms', type: 'userTask', name: 'Approve Terms', col: 1, props: { templateFields: pretrade, assetOperation: { assetId: 'cash', operation: 'deposit', params: { amountSource: 'field', amountField: 'reserve' } } } },
        { id: 'Task_Mandate', type: 'userTask', name: 'Mandate Paying Agent', col: 2 },
        { id: 'End_Issuer', type: 'endEvent', name: 'Mandated', col: 3 },
      ], flows: chain('I_F', 'Start_Issuer', 'Task_ApproveTerms', 'Task_Mandate', 'End_Issuer') },
      { id: 'Part_PayingAgent', name: PA, proc: 'Proc_PayingAgent', nodes, flows },
      { id: 'Part_Investor', name: INVESTOR, proc: 'Proc_Investor', nodes: [
        { id: 'Recv_Offer', type: 'receiveTask', name: 'Offer Listed', col: 4 },
        // The subscription book: anyone, any number of times, until the strike date.
        { id: 'Task_Subscribe', type: 'userTask', name: 'Subscribe', col: 5, props: {
          until: { dateField: 'strikeDate' },
          templateFields: [field('units', 'Decimal')],
          assetOperations: [
            { assetId: 'cash', operation: 'deposit', params: { amountSource: 'expr', amountExpr: `units * ${issuePrice}` } },
            { assetId: 'note', operation: 'swap', params: { deliveryParty: ISSUER, paymentParty: INVESTOR, amountSource: 'field', amountField: 'units', counterAssetId: 'cash', counterAmountSource: 'expr', counterAmountExpr: `units * ${issuePrice}` } },
          ],
        } },
        { id: 'End_Investor', type: 'endEvent', name: 'Book Closed', col: 6 },
      ], flows: chain('V_F', 'Recv_Offer', 'Task_Subscribe', 'End_Investor') },
    ],
    messages: [
      { id: 'MF_Mandate', src: 'Task_Mandate', tgt: 'Recv_Mandate' },
      { id: 'MF_Offer', src: 'Task_IssueNote', tgt: 'Recv_Offer' },
    ],
    assets,
  });
  return {
    ...built,
    id: `product-${p.productType}`,
    name: p.name,
    params: p,
    description: `${label} on ${p.underlying.symbol}: ${n} observation${n > 1 ? 's' : ''} per issuance, size and dates set at pre-trade; investors subscribe in USDC until the strike date; Chainlink CRE fixes the strike and observes from the ${p.underlying.symbol}/USD feed. 3 pools: Issuer, Paying Agent, Investor.`,
  };
}
