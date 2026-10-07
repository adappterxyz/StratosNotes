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
 *
 * Worst-of baskets replace o_k / S with the worst performer's min(o_ik / S_i).
 */
export interface PayoffResult {
  coupons: number[];
  calledAt?: number;
  redemptionCash: number;
}

export function simulatePayoff(p: ProductParams, strike: number, prices: number[]): PayoffResult {
  return run(p, prices.length, (k, lvl) => prices[k - 1] >= strike * lvl / 100, k => prices[k - 1] / strike);
}

/**
 * Worst-of: `strikes[i]` per underlying, `paths[k - 1][i]` its level at
 * observation k. Every test uses the worst performance min(level_i / strike_i)
 * (a single underlying gives the same result as simulatePayoff).
 */
export function simulateWorstOf(p: ProductParams, strikes: number[], paths: number[][]): PayoffResult {
  return simulatePerf(p, paths.map(row => Math.min(...row.map((o, i) => o / strikes[i]))));
}

/** Payoff from the worst performance at each observation (1 = at strike). */
export function simulatePerf(p: ProductParams, perfs: number[]): PayoffResult {
  return run(p, perfs.length, (k, lvl) => perfs[k - 1] >= lvl / 100, k => perfs[k - 1]);
}

function run(p: ProductParams, len: number, atLeast: (k: number, levelPct: number) => boolean, ratio: (k: number) => number): PayoffResult {
  const n = p.observations;
  if (len !== n) throw new Error(`need ${n} observations, got ${len}`);
  const rate = (p.couponRatePct ?? 0) / 100;
  const from = p.autocallFromPeriod ?? 1;
  const coupons: number[] = [];
  let missed = 0;
  for (let k = 1; k <= n; k++) {
    let c = 0;
    if (p.productType === 'fcn' || p.productType === 'reverse-convertible') c = rate;
    if (p.productType === 'phoenix') {
      if (atLeast(k, p.couponBarrierPct ?? 0)) { c = rate * (p.memory ? missed + 1 : 1); missed = 0; } else missed += 1;
    }
    coupons.push(c);
    const autocalls = p.productType === 'fcn' || p.productType === 'phoenix' || p.productType === 'snowball';
    if (autocalls && k >= from && k < n && atLeast(k, p.autocallLevelPct ?? 0)) {
      return { coupons, calledAt: k, redemptionCash: 1 + (p.productType === 'snowball' ? rate * k : 0) };
    }
  }
  const r = ratio(n);
  if (p.productType === 'ppn') {
    const up = r > 1 ? ((p.participationPct ?? 0) / 100) * (r - 1) : 0;
    return { coupons, redemptionCash: (p.protectionPct ?? 0) / 100 + up };
  }
  if (p.productType === 'snowball' && atLeast(n, p.autocallLevelPct ?? 0)) return { coupons, redemptionCash: 1 + rate * n };
  if (atLeast(n, p.knockInBarrierPct ?? 0)) return { coupons, redemptionCash: 1 };
  return { coupons, redemptionCash: r };
}

/** Total cash one unit receives along the path. */
export const totalPerUnit = (r: PayoffResult) => r.coupons.reduce((a, b) => a + b, 0) + r.redemptionCash;
