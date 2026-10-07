/**
 * The seed template library: four stock products and two custom workflows
 * (product workflows edited through the draft format the AI edits, then
 * checked by the validator). scripts/seed-templates.ts publishes them;
 * test/products.e2e.test.ts runs the custom ones on a local validator.
 */
import { check } from '../validate';
import { draftToIR, irToBpmn, irToDraft, type WorkflowDraft } from '../draft';
import { parseBpmn } from '../bpmn';
import type { TemplateSource } from '../templates';
import { instantiateProduct } from './instantiate';
import { EXAMPLE_PRODUCTS, EXAMPLE_WORST_OF, FEEDS, type ProductParams } from './params';

/** A product workflow, edited as a draft, back to BPMN (validated). */
function custom(basis: ProductParams, name: string, edit: (d: WorkflowDraft) => void): TemplateSource {
  const prod = instantiateProduct(basis);
  const d = irToDraft(parseBpmn(prod.bpmnXml, prod.assets));
  d.name = name;
  edit(d);
  const ir = draftToIR(d);
  const { bpmnXml } = irToBpmn(ir);
  const issues = check(parseBpmn(bpmnXml, prod.assets));
  if (issues.errors.length) throw new Error(`${name}: ${issues.errors.map(e => e.message).join('; ')}`);
  return { bpmnXml, assets: prod.assets, basis };
}

const step = (d: WorkflowDraft, id: string) => {
  const s = d.steps.find(x => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
};

const worstOfFcn: ProductParams = { ...EXAMPLE_PRODUCTS.fcn, name: '12M Worst-of FCN on ETH, BTC', underlyings: [FEEDS.ETH, FEEDS.BTC], couponRatePct: 2.5 };
const btcSnowball: ProductParams = { ...EXAMPLE_PRODUCTS.snowball, name: '12M Snowball on BTC', underlyings: [FEEDS.BTC], couponRatePct: 2.5 };
const solPpn: ProductParams = { ...EXAMPLE_PRODUCTS.ppn, name: '6M 90% Protected Note on SOL', underlyings: [FEEDS.SOL], protectionPct: 90, participationPct: 100 };
const ethPhoenix: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Step-down Phoenix on ETH' };
const btcPhoenix: ProductParams = { ...EXAMPLE_PRODUCTS.phoenix, name: '12M Phoenix on BTC with servicing fee', underlyings: [FEEDS.BTC], couponRatePct: 2.5 };

export const SEED_TEMPLATES: Array<{ name: string; description: string; source: TemplateSource }> = [
  {
    name: '12M Worst-of Phoenix on ETH, BTC, SOL',
    description: '3% quarterly coupon while the worst of ETH, BTC and SOL holds 70% of its strike, with memory; autocalls at 100% from Q2; 60% knock-in on the worst performer.',
    source: { product: EXAMPLE_WORST_OF },
  },
  {
    name: '12M Worst-of FCN on ETH, BTC',
    description: 'Fixed 2.5% quarterly coupon; autocalls when both ETH and BTC are at or above their strikes; capital at risk below 60% of the worst performer.',
    source: { product: worstOfFcn },
  },
  {
    name: '12M Snowball on BTC',
    description: 'Accrues 2.5% a quarter, paid in full on autocall at 100% of the BTC strike or at maturity if above it; 65% knock-in.',
    source: { product: btcSnowball },
  },
  {
    name: '6M 90% Protected Note on SOL',
    description: '90% of face back at maturity whatever SOL does, plus 100% of any rise above the strike. One observation at maturity.',
    source: { product: solPpn },
  },
  {
    name: '12M Step-down Phoenix on ETH',
    description: 'Custom: the autocall level steps down, 100% of the ETH strike at Q2 and 95% at Q3, so the note is likelier to call early. 2.5% memory coupon above 70%; 60% knock-in at maturity.',
    source: custom(ethPhoenix, '12M Step-down Phoenix on ETH', d => {
      // Autocall at Q2 at 100%, at Q3 at 95% (each gateway's "Autocall" branch condition); maturity is unchanged.
      const levels: Record<number, number> = { 2: 100, 3: 95 };
      for (const [k, lvl] of Object.entries(levels)) {
        const gw = step(d, `GW_Autocall${k}`);
        const b = gw.branches?.find(x => !x.default);
        if (!b) throw new Error(`GW_Autocall${k} has no autocall branch`);
        b.condition = `obs${k} >= initialLevel * ${lvl} / 100`;
        b.label = `Autocall (${lvl}%)`;
      }
    }),
  },
  {
    name: '12M Phoenix on BTC with servicing fee',
    description: 'Custom: a BTC phoenix (2.5% memory coupon above 70%, autocall 100% from Q2, 60% knock-in) where the issuer pays the paying agent 0.1% of the issue size with each coupon; the fees are deposited with the reserve.',
    source: custom(btcPhoenix, '12M Phoenix on BTC with servicing fee', d => {
      // The issuer funds the fees up front with the coupon reserve (one per observation at most),
      // so paying them can never leave the redemption short.
      const terms = step(d, 'Task_ApproveTerms');
      terms.ops = (terms.ops ?? []).map(o => (o.operation === 'deposit'
        ? { ...o, params: { amountSource: 'expr' as const, amountExpr: `reserve + notional * ${btcPhoenix.observations} / 1000` } } : o));
      for (const s of d.steps.filter(x => /^Task_Coupon\d+$/.test(x.id))) {
        s.ops = [...(s.ops ?? []), { assetId: 'cash', operation: 'transfer', params: { from: 'Issuer', to: 'Paying Agent', amountSource: 'expr', amountExpr: 'notional * 1 / 1000' } }];
        s.name = `${s.name} + Servicing Fee`;
      }
    }),
  },
];

