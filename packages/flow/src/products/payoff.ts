import type { ProductParams } from './params';

/**
 * Reference payoff (Flow's products/payoff.ts): for a price path, what ONE
 * unit of face is paid. It is the specification the on-chain workflow is
 * tested against (test/products.e2e.test.ts).
 *
 * Per observation k = 1..n, strike S, price o_k:
 *  - FCN / reverse convertible: coupon every period.
 *  - Phoenix: coupon only if o_k >= S x couponBarrier; with memory it also
 *    pays every coupon missed since the last one paid.
 *  - Snowball: no periodic coupon; an autocall pays 1 + rate x k.
 *  - Autocall (FCN, phoenix, snowball), after the period's coupon, for
 *    autocallFrom <= k < n: o_k >= S x autocallLevel redeems at 1 (snowball
 *    1 + rate x k).
 *  - Maturity: snowball pays 1 + rate x n if o_n >= S x autocallLevel.
 *    Otherwise o_n >= S x knockIn redeems at 1; below it, o_n / S in cash.
 *  - PPN: protection + participation x max(0, o_n / S - 1).
 */
export interface PayoffResult {
  coupons: number[];
  calledAt?: number;
  redemptionCash: number;
}

export function simulatePayoff(p: ProductParams, strike: number, prices: number[]): PayoffResult {
  const n = p.observations;
  if (prices.length !== n) throw new Error(`need ${n} observations, got ${prices.length}`);
  const rate = (p.couponRatePct ?? 0) / 100;
  const ac = (p.autocallLevelPct ?? 0) / 100;
  const from = p.autocallFromPeriod ?? 1;
  const coupons: number[] = [];
  let missed = 0;
  for (let k = 1; k <= n; k++) {
    const o = prices[k - 1];
    let c = 0;
    if (p.productType === 'fcn' || p.productType === 'reverse-convertible') c = rate;
    if (p.productType === 'phoenix') {
      if (o >= strike * (p.couponBarrierPct ?? 0) / 100) { c = rate * (p.memory ? missed + 1 : 1); missed = 0; } else missed += 1;
    }
    coupons.push(c);
    const autocalls = p.productType === 'fcn' || p.productType === 'phoenix' || p.productType === 'snowball';
    if (autocalls && k >= from && k < n && o >= strike * ac) {
      return { coupons, calledAt: k, redemptionCash: 1 + (p.productType === 'snowball' ? rate * k : 0) };
    }
  }
  const o = prices[n - 1];
  if (p.productType === 'ppn') {
    const up = o > strike ? ((p.participationPct ?? 0) / 100) * (o / strike - 1) : 0;
    return { coupons, redemptionCash: (p.protectionPct ?? 0) / 100 + up };
  }
  if (p.productType === 'snowball' && o >= strike * ac) return { coupons, redemptionCash: 1 + rate * n };
  if (o >= strike * (p.knockInBarrierPct ?? 0) / 100) return { coupons, redemptionCash: 1 };
  return { coupons, redemptionCash: o / strike };
}

/** Total cash one unit receives along the path. */
export const totalPerUnit = (r: PayoffResult) => r.coupons.reduce((a, b) => a + b, 0) + r.redemptionCash;
