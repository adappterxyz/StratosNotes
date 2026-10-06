import { describe, it, expect } from 'vitest';
import { compile, decodeDef, encodeDef, parseBpmn, instantiateProduct, EXAMPLE_PRODUCTS, KIND, OP, SRC, NO_EXPR, parsePred, dec, mul, div, type ProductType } from '../src';

const types = Object.keys(EXAMPLE_PRODUCTS) as ProductType[];

describe('decimal', () => {
  it('truncates like the program', () => {
    expect(mul(dec('1.5'), dec('0.3333333333'))).toBe(dec('0.49999999995'.slice(0, 12)));
    expect(div(dec(1), dec(3))).toBe(dec('0.3333333333'));
    expect(div(dec(-1), dec(3))).toBe(-dec('0.3333333333'));
  });
});

describe('products compile to engine definitions', () => {
  for (const t of types) {
    it(`${t}: BPMN round-trips and compiles`, () => {
      const prod = instantiateProduct(EXAMPLE_PRODUCTS[t]);
      const ir = parseBpmn(prod.bpmnXml, prod.assets);
      expect(ir.pools.map(p => p.name)).toEqual(['Issuer', 'Paying Agent', 'Investor']);
      const c = compile(ir, { product: prod.params });
      expect(decodeDef(c.bytes)).toEqual(c.def);
      expect(encodeDef(decodeDef(c.bytes))).toEqual(c.bytes);
      const s = (id: string) => c.def.steps[c.stepIndex[id]];
      // Pre-trade deposit, the open subscription window, oracle steps on their dates.
      expect(s('Task_ApproveTerms').ops[0].kind).toBe(OP.DEPOSIT);
      expect(s('Task_Subscribe').until).toEqual({ kind: 1, at: 0n, field: c.fieldIndex.strikeDate });
      expect(s('Task_Subscribe').ops.map(o => o.kind)).toEqual([OP.DEPOSIT, OP.SWAP]);
      expect(s('Task_FixStrike').captures[0].source).toBe(SRC.ORACLE);
      expect(s('Task_Observe1').timer).toEqual({ kind: 1, at: 0n, field: c.fieldIndex.obsDate1 });
      expect(s('Task_Mandate').sends).toEqual([c.stepIndex.Recv_Mandate]);
      expect(s('Recv_Mandate').guard).not.toBe(NO_EXPR);
      expect(c.def.steps.filter(x => x.kind === KIND.XOR).every(x => x.next.some(e => e.isDefault))).toBe(true);
      expect(c.bytes.length).toBeLessThan(40_000);
      // Same workflow, same bytes, same address.
      expect(compile(parseBpmn(prod.bpmnXml, prod.assets), { product: prod.params }).hash).toEqual(c.hash);
    });
  }
  it('rejects unknown fields and pools with clear messages', () => {
    const prod = instantiateProduct(EXAMPLE_PRODUCTS.fcn);
    const ir = parseBpmn(prod.bpmnXml.replace('notional &gt; 0', 'nope &gt; 0'), prod.assets);
    expect(() => compile(ir)).toThrow(/'nope' is not a workflow field/);
  });
  it('parses predicates with and/or', () => {
    const r = parsePred('obs1 >= initialLevel * 70 / 100 and obs1 < initialLevel or 1 == 1');
    expect(r.ok && r.refs).toEqual(['initialLevel', 'obs1']);
  });
});
