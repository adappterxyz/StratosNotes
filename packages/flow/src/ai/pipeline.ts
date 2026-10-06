/**
 * The AI leg (Flow's ai/router.ts + pipeline.ts, for StratosNotes):
 *   route with the decision model (Clef) -> clarify | product | edit | answer
 *  - product: required terms are checked first; missing ones become a
 *    question, never an invented number. The model fills ProductParams for a
 *    verified payoff engine; the issuer reviews them in the issue form.
 *  - edit: the open workflow goes to the model as a draft; it answers with a
 *    patch; the real validator + compiler check the result and their errors go
 *    back for repair (bounded). The BPMN is laid out deterministically.
 */
import type { AiRunner, ChatMessage, DecisionQuestion } from './runner';
import { extractProduct, type Schedule } from './extract';
import { PRODUCT_LABELS, productUses, type ProductParams, type ProductType } from '../products/params';
import { applyPatch, draftToIR, irToBpmn, type DraftPatch, type WorkflowDraft } from '../draft';
import { check } from '../validate';

export type Intent = 'product' | 'edit' | 'question';
export const CONFIDENCE_FLOOR = 0.55;

export type AiResult =
  | { kind: 'reply'; reply: string }
  | { kind: 'clarify'; reply: string; missing: string[] }
  | { kind: 'product'; params: ProductParams; schedule: Schedule; notes: string[] }
  | { kind: 'workflow'; bpmnXml: string; draft: WorkflowDraft; warnings: string[]; changed: string[] }
  | { kind: 'error'; error: string };

const INTENTS: Record<Intent, string> = {
  product: 'Design or issue a structured note from terms: fixed coupon note, autocallable, phoenix, snowball, reverse convertible or principal-protected note',
  edit: 'Change the note or workflow that is open: how or when it pays (bonuses, fees, coupons, redemption), its steps, fields, conditions, dates or rules, e.g. "when it autocalls pay an extra 1%", "add a fee", "observe monthly"',
  question: 'Ask how something works or for an explanation or advice; or just chat. Nothing should be built or changed',
};
const PRODUCTS: Record<ProductType, string> = {
  'fcn': 'Fixed coupon note: a fixed coupon every period, may autocall, knock-in at maturity',
  'reverse-convertible': 'Reverse convertible: fixed coupon, no autocall, loss below a barrier at maturity',
  'phoenix': 'Phoenix: coupon paid only when the underlying is above a coupon barrier, optional memory, autocall',
  'snowball': 'Snowball: coupons accrue and are paid only when the note is called',
  'ppn': 'Principal-protected note: capital protection plus participation in the rise, no coupons',
};

function termQuestions(t: ProductType): Array<[string, string, string]> {
  const use = productUses(t);
  const q: Array<[string, string, string]> = [
    ['underlying', 'the underlying', 'Is a specific token, stock or index named in the request (e.g. "ETH", "Bitcoin", "SOL")?'],
    ['tenor', 'the tenor or the observation schedule', 'Does the request state the tenor, maturity or how often it is observed (e.g. "12 months", "quarterly")?'],
  ];
  if (use.coupon) q.push(['coupon', 'the coupon rate', 'Does the request state a coupon rate?']);
  if (use.couponBarrier) q.push(['couponBarrier', 'the coupon barrier', 'Does the request state a coupon barrier level (a % of the initial level)?']);
  if (use.autocall) q.push(['autocall', 'the autocall level', 'Does the request state an autocall or early-redemption level?']);
  if (use.knockIn) q.push(['knockIn', 'the knock-in barrier', 'Does the request state a knock-in, protection or downside barrier level?']);
  if (use.protection) q.push(['protection', 'the capital protection level', 'Does the request state how much capital is protected?'], ['participation', 'the participation rate', 'Does the request state a participation rate in the upside?']);
  return q;
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export const BRIEF = `You are the StratosNotes assistant. Answer briefly and concretely, only from these facts; if the answer is not covered, say so rather than guess.
StratosNotes issues structured notes on Solana. A note is a BPMN workflow with three pools: Issuer (approves this issuance's terms, size and dates at pre-trade and deposits a USDC coupon reserve), Paying Agent (issues the note, fixes the strike and observes on each date, pays coupons, autocalls and redeems) and Investor (an open role: anyone subscribes with USDC until the strike date, receiving note units in one atomic swap).
One Solana program (the engine) runs every workflow; Chainlink CRE fixes the strike and delivers each observation from a Chainlink price feed as a signed report through Chainlink's forwarder; coupons and redemptions settle on-chain and investors withdraw USDC.
Products: fixed coupon note, reverse convertible, phoenix (optional memory), snowball, principal-protected note. Underlyings with feeds here: ETH, BTC, SOL. Settlement is in cash.
Issuers can also edit a note's workflow in the studio (steps, fields, gateway conditions such as "obs2 >= initialLevel * 100 / 100", timers, payments) before publishing it.`;

const EDIT_RULES = `You edit a StratosNotes workflow (it runs on a Solana engine). The workflow is JSON: parties (pools), assets, steps.
Step kinds: "start"; "task" (a person in that pool acts, may enter fields); "auto" (runs by itself: payments, formula fields, or price observations); "receive" (waits for another pool's message); "decision" (exclusive gateway: "branches", either all but one with a "condition" plus one default, or none so a person picks); "parallel"; "end".
Links: "next" (same pool), "branches" (decisions), "sendTo" (step ids in OTHER pools). Every path ends in an "end".
Fields: {name, type: Decimal|Int|Date|Text|Party|Bool}; add "formula" (e.g. "missed1 + 1") for computed fields, or "oracle": {feed, feedChain, min, max} for a Chainlink price observed by CRE (only on "auto" steps). Field names are camelCase and shared by all pools.
Timers: "timerField" (a Date field: the step waits for it). "untilField" on a "task": anyone may repeat it until that date (a subscription book).
Payments ("ops", applied in order): {assetId, operation, params}. operation: "deposit" (USDC from the person running the task; params.amountSource "field"|"expr" with amountField/amountExpr), "mint" (params.owner = pool name), "transfer" (params.from and params.to are POOL names; params.amountSource "expr", params.amountExpr = the TOTAL amount), "swap" (deliveryParty, paymentParty, counterAssetId, amounts), "distribute" (pays EVERY HOLDER of params.holdingAssetId, i.e. the investors: params.payer pays amountExpr PER UNIT held; params.retire true redeems the units).
Who gets paid decides the operation: investors/noteholders -> "distribute"; one named pool (the issuer, the paying agent, a fee to someone) -> "transfer" with from/to. A fee "per unit" or "% of the notional" paid to one pool is a transfer of the total, e.g. a 0.1% fee to the paying agent from the issuer: {"assetId":"cash","operation":"transfer","params":{"from":"Issuer","to":"Paying Agent","amountSource":"expr","amountExpr":"notional * 1 / 1000"}}.
Conditions and amounts are expressions over fields: + - * / and comparisons, "and"/"or".
Reply with a patch: "upsert" new steps and every changed step written out in full (e.g. the step before an inserted one, with its new "next"), and "remove" ids of deleted steps. Keep ids of unchanged steps; do not repeat unchanged steps.`;

const PATCH_SCHEMA = {
  type: 'object',
  properties: {
    upsert: { type: 'array', items: { type: 'object', required: ['id', 'party', 'kind', 'name'] } },
    remove: { type: 'array', items: { type: 'string' } },
    parties: { type: 'array', items: { type: 'string' } },
  },
};

export async function editWorkflow(ai: AiRunner, prompt: string, base: WorkflowDraft, maxRepairs = 3): Promise<AiResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: EDIT_RULES },
    { role: 'user', content: `Current workflow:\n${JSON.stringify(base)}\n\nChange requested:\n${prompt}` },
  ];
  let errors: string[] = [];
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const patch = await ai.json<DraftPatch>(messages, PATCH_SCHEMA, 'workflow_patch').catch(() => null);
    if (!patch || (!Array.isArray(patch.upsert) && !Array.isArray(patch.remove))) { errors = ['The reply was not a patch.']; continue; }
    messages.push({ role: 'assistant', content: JSON.stringify(patch) });
    const draft = applyPatch(base, patch);
    let ir;
    try { ir = draftToIR(draft); } catch (e) { errors = [e instanceof Error ? e.message : String(e)]; }
    if (ir) {
      const r = check(ir);
      errors = r.errors.map(e => `${e.nodeId ? `[${e.nodeId}] ` : ''}${e.message}`);
      if (!errors.length) {
        const changed = [...(patch.upsert ?? []).map(s => s.id), ...(patch.remove ?? [])];
        return { kind: 'workflow', bpmnXml: irToBpmn(ir).bpmnXml, draft, warnings: r.warnings.map(w => w.message), changed };
      }
    }
    messages.push({ role: 'user', content: `The compiler rejects that:\n- ${errors.join('\n- ')}\nFix these with another patch against the ORIGINAL workflow (repeat your earlier changes, corrected).` });
  }
  return { kind: 'error', error: `I couldn't produce a valid change. Remaining problems: ${errors.slice(0, 5).join('; ')}` };
}

export async function runAi(ai: AiRunner, input: { prompt: string; today: string; draft?: WorkflowDraft }): Promise<AiResult> {
  const hasWorkflow = !!input.draft?.steps?.length;
  const criteria = Object.fromEntries((Object.keys(INTENTS) as Intent[]).filter(i => hasWorkflow || i !== 'edit').map(i => [i, INTENTS[i]]));
  const first = await ai.decide(input.prompt, { intent: { type: 'choice', instructions: 'What does the user want StratosNotes to do?', criteria } }, { precise: true });
  const intent = (first.intent?.choice as Intent) || 'question';
  if ((first.intent?.confidence ?? 0) < CONFIDENCE_FLOOR) {
    return { kind: 'clarify', missing: ['intent'], reply: hasWorkflow ? 'Do you want me to change the open workflow, set up a new note from terms, or answer a question?' : 'Do you want me to set up a note from terms, or answer a question?' };
  }
  if (intent === 'question') {
    const reply = await ai.text([{ role: 'system', content: BRIEF + (hasWorkflow ? `\n\nThe open workflow, as JSON:\n${JSON.stringify(input.draft)}` : '') }, { role: 'user', content: input.prompt }]);
    return { kind: 'reply', reply };
  }
  if (intent === 'edit' && input.draft) return editWorkflow(ai, input.prompt, input.draft);

  const productQ: Record<string, DecisionQuestion> = { product: { type: 'choice', instructions: 'Which structured note is requested?', criteria: PRODUCTS } };
  const p = await ai.decide(input.prompt, productQ, { precise: true });
  const product = p.product?.choice as ProductType | undefined;
  if (!product || !PRODUCT_LABELS[product]) return { kind: 'clarify', missing: ['product'], reply: 'Which note do you want: a fixed coupon note, reverse convertible, phoenix, snowball or principal-protected note?' };
  const terms = termQuestions(product);
  const answers = await ai.decide(input.prompt, Object.fromEntries(terms.map(([k, , ins]) => [k, { type: 'noul', instructions: ins } as DecisionQuestion])), { precise: true });
  const missing = terms.filter(([k]) => (answers[k]?.noul ?? 0) < 0.5).map(([, label]) => label);
  if (missing.length) return { kind: 'clarify', missing, reply: `To set up the ${PRODUCT_LABELS[product].toLowerCase()} I still need ${list(missing)}. What are they?` };
  const r = await extractProduct(ai, input.prompt, product, input.today);
  if ('errors' in r) return { kind: 'clarify', missing: r.errors, reply: r.errors.join(' ') };
  return { kind: 'product', params: r.params, schedule: r.schedule, notes: r.notes };
}
