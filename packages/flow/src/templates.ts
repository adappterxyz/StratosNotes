/**
 * Note templates: a workflow an issuer saved from the studio so that anyone
 * can issue it again. The workflow itself is a sealed definition on Solana
 * (content-addressed); the registry (the app Worker) keeps what is needed to
 * reopen it on the canvas and label it: the term sheet of a stock product, or
 * the BPMN of a custom one. The registry recompiles every entry and accepts it
 * only if it lands on the definition address it claims.
 */
import { PublicKey } from '@solana/web3.js';
import idlJson from '../idl/flow_engine.json';
import { parseBpmn } from './bpmn';
import { compile, type Compiled } from './compile';
import { instantiateProduct } from './products/instantiate';
import { normalizeParams, PRODUCT_LABELS, underlyingLabel, type ProductParams } from './products/params';
import type { AssetDefinition } from './types';

export interface TemplateSource {
  /** A stock product: the workflow is instantiated from this term sheet. */
  product?: ProductParams;
  /** A custom workflow: its BPMN and assets; `basis` is the product it was edited from, if any. */
  bpmnXml?: string;
  assets?: AssetDefinition[];
  basis?: ProductParams;
}

export interface TemplateEntry extends TemplateSource {
  definition: string;
  name: string;
  description: string;
  /** The wallet that saved it (it signed `templateMessage(definition)`). */
  author: string;
  createdAt: number;
}

/** What the registry lists (the full entry is fetched on open). */
export interface TemplateSummary {
  definition: string;
  name: string;
  description: string;
  author: string;
  createdAt: number;
  kind: 'product' | 'custom';
  /** e.g. "Phoenix Autocallable · worst of ETH, BTC". */
  label: string;
}

export function summarize(t: TemplateEntry): TemplateSummary {
  const p = t.product ?? t.basis;
  const label = p ? `${t.product && !t.bpmnXml ? '' : 'Custom '}${PRODUCT_LABELS[normalizeParams(p).productType]} · ${underlyingLabel(normalizeParams(p))}` : 'Custom workflow';
  return { definition: t.definition, name: t.name, description: t.description, author: t.author, createdAt: t.createdAt, kind: t.product && !t.bpmnXml ? 'product' : 'custom', label };
}

export const templateMessage = (definition: string) => `StratosNotes: publish template ${definition}`;

/** The BPMN a template opens with. */
export function templateBpmn(t: TemplateSource): { bpmnXml: string; assets: AssetDefinition[] } {
  if (t.product && !t.bpmnXml) {
    const prod = instantiateProduct(normalizeParams(t.product));
    return { bpmnXml: prod.bpmnXml, assets: prod.assets };
  }
  if (!t.bpmnXml || !t.assets) throw new Error('A template needs a product term sheet or a BPMN workflow with its assets.');
  return { bpmnXml: t.bpmnXml, assets: t.assets };
}

/**
 * Compile a template exactly as the studio publishes it: a stock product with
 * its term sheet as metadata (the marketplace prices it from the reference
 * payoff); a custom workflow marked custom (its payoff is the workflow).
 */
export function compileTemplate(t: TemplateSource): Compiled {
  const { bpmnXml, assets } = templateBpmn(t);
  const ir = parseBpmn(bpmnXml, assets);
  if (t.product && !t.bpmnXml) return compile(ir, { product: normalizeParams(t.product) });
  return compile(ir, { ...(t.basis ? { product: normalizeParams(t.basis) } : {}), custom: true });
}

/** The engine account a compiled workflow lives at. */
export function definitionAddress(c: Compiled): string {
  const program = new PublicKey((idlJson as { address: string }).address);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode('def'), c.hash], program)[0].toBase58();
}
