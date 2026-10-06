import { describe, it, expect } from 'vitest';
import { applyPatch, check, compile, draftToIR, EXAMPLE_PRODUCTS, instantiateProduct, irToBpmn, irToDraft, parseBpmn, type ProductType } from '../src';
import { runAi } from '../src/ai/pipeline';
import type { AiRunner, DecisionAnswers } from '../src/ai/runner';

/** A scripted runner: decisions by question key, JSON replies in order. */
function fake(decisions: Record<string, Partial<DecisionAnswers[string]>>, json: unknown[] = [], text = 'ok'): AiRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async decide(_state, questions) {
      return Object.fromEntries(Object.keys(questions).map(k => [k, { type: 'x', ...(decisions[k] ?? { noul: 1 }) }])) as DecisionAnswers;
    },
    async json<T>(messages: Array<{ content: string }>) { prompts.push(messages[messages.length - 1].content); const r = json.shift(); if (r === undefined) throw new Error('no reply'); return r as T; },
    async text() { return text; },
  };
}

const productDraft = (t: ProductType) => {
  const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
  return irToDraft(parseBpmn(prod.bpmnXml, prod.assets));
};

describe('drafts', () => {
  for (const t of Object.keys(EXAMPLE_PRODUCTS) as ProductType[]) {
    it(`${t}: BPMN -> draft -> BPMN keeps the compiled workflow`, () => {
      const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      const back = parseBpmn(irToBpmn(draftToIR(irToDraft(ir))).bpmnXml, prod.assets);
      expect(check(back).errors).toEqual([]);
      const a = compile(ir).def, b = compile(back).def;
      const shape = (d: typeof a) => d.steps.map(s => [s.id, s.kind, d.roles[s.role], s.captures.length, s.ops.map(o => o.kind), s.next.length, s.sends.length, !!s.timer, !!s.until]).sort();
      expect(shape(b)).toEqual(shape(a));
    });
  }
  it('patches insert, replace and remove steps; dangling links are dropped', () => {
    const d = productDraft('fcn');
    const p = applyPatch(d, { upsert: [{ id: 'Task_Notify', party: 'Paying Agent', kind: 'auto', name: 'Notify', next: 'End_Par' }], remove: ['Task_RedeemPar'] });
    expect(p.steps.find(s => s.id === 'Task_Notify')).toBeDefined();
    expect(p.steps.some(s => s.id === 'Task_RedeemPar')).toBe(false);
    expect(p.steps.find(s => s.id === 'GW_KnockIn')!.branches!.map(b => b.next)).not.toContain('Task_RedeemPar');
  });
  it('the validator catches a broken edit', () => {
    const d = productDraft('fcn');
    const broken = applyPatch(d, { remove: ['End_Par'] });
    expect(check(draftToIR(broken)).errors.map(e => e.code)).toContain('DEAD_END');
  });
});

describe('AI pipeline (scripted models)', () => {
  it('asks for missing terms instead of inventing them', async () => {
    const ai = fake({ intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'phoenix', confidence: 0.9 }, couponBarrier: { noul: 0.1 }, knockIn: { noul: 0.2 } });
    const r = await runAi(ai, { prompt: 'A phoenix on ETH, 10% p.a. quarterly, autocall 100%, one year', today: '2026-10-06' });
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.missing).toEqual(['the coupon barrier', 'the knock-in barrier']);
  });
  it('extracts a product, converting an annual coupon from the quoted words', async () => {
    const prompt = 'Phoenix on ETH, 10% p.a. paid quarterly, coupon barrier 70%, memory, autocall 100% from the 2nd quarter, knock-in 60%, one year, 50,000 USDC';
    const ai = fake({ intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'phoenix', confidence: 0.9 } }, [{
      productType: 'phoenix', name: '12M Phoenix on ETH', size: 50000, issuePricePct: null, underlyingSymbol: 'ETH', observationEveryMonths: 3, observationCount: 4,
      couponRatePct: 2.5, couponAsStated: '10% p.a. paid quarterly', couponRateBasis: 'per-annum', couponBarrierPct: 70, memory: true,
      autocallLevelPct: 100, autocallFromPeriod: 2, knockInBarrierPct: 60, protectionPct: null, participationPct: null,
    }]);
    const r = await runAi(ai, { prompt, today: '2026-10-06' });
    expect(r.kind).toBe('product');
    if (r.kind !== 'product') return;
    expect(r.params).toMatchObject({ productType: 'phoenix', couponRatePct: 2.5, couponBarrierPct: 70, memory: true, autocallLevelPct: 100, autocallFromPeriod: 2, knockInBarrierPct: 60, observations: 4 });
    expect(r.params.underlying.symbol).toBe('ETH');
    expect(r.schedule).toEqual({ every: 3, unit: 'months', count: 4, size: 50000 });
    expect(r.notes.join(' ')).toMatch(/10% p\.a\..*2\.5% per period/);
  });
  it('refuses an underlying with no Chainlink feed here', async () => {
    const ai = fake({ intent: { choice: 'product', confidence: 0.9 }, product: { choice: 'fcn', confidence: 0.9 } }, [{
      productType: 'fcn', name: 'FCN on DOGE', size: null, issuePricePct: null, underlyingSymbol: 'DOGE', observationEveryMonths: 3, observationCount: 4,
      couponRatePct: 2, couponAsStated: null, couponRateBasis: 'per-period', couponBarrierPct: null, memory: null, autocallLevelPct: 100, autocallFromPeriod: null, knockInBarrierPct: 60, protectionPct: null, participationPct: null,
    }]);
    const r = await runAi(ai, { prompt: 'FCN on DOGE, 2% quarterly, autocall 100, KI 60, 1y', today: '2026-10-06' });
    expect(r.kind).toBe('clarify');
    if (r.kind === 'clarify') expect(r.reply).toMatch(/no Chainlink price feed for DOGE.*ETH, BTC, SOL/);
  });
  it('edits the open workflow with a patch, repairing what the validator rejects', async () => {
    const draft = productDraft('fcn');
    const fee = { assetId: 'cash', operation: 'distribute', params: { holdingAssetId: 'note', payer: 'Issuer', amountSource: 'expr', amountExpr: '1 / 100' } };
    const ai = fake({ intent: { choice: 'edit', confidence: 0.9 } }, [
      // First try: links to a step that does not exist -> the step dead-ends.
      { upsert: [{ ...draft.steps.find(s => s.id === 'Task_Coupon1')!, next: 'Task_Bonus1' }, { id: 'Task_Bonus1', party: 'Paying Agent', kind: 'auto', name: 'Loyalty bonus', ops: [fee] }] },
      // Repaired.
      { upsert: [{ ...draft.steps.find(s => s.id === 'Task_Coupon1')!, next: 'Task_Bonus1' }, { id: 'Task_Bonus1', party: 'Paying Agent', kind: 'auto', name: 'Loyalty bonus', ops: [fee], next: draft.steps.find(s => s.id === 'Task_Coupon1')!.next }] },
    ]);
    const r = await runAi(ai, { prompt: 'Pay a 1% loyalty bonus after the first coupon', today: '2026-10-06', draft });
    expect(r.kind).toBe('workflow');
    if (r.kind !== 'workflow') return;
    expect(ai.prompts[1]).toMatch(/Task_Bonus1.*no outgoing flow/);
    expect(r.changed).toEqual(['Task_Coupon1', 'Task_Bonus1']);
    const ir = parseBpmn(r.bpmnXml, draft.assets);
    expect(check(ir).errors).toEqual([]);
    expect(ir.nodes.find(n => n.id === 'Task_Bonus1')?.props.assetOperation?.operation).toBe('distribute');
  });
});
