/**
 * ProductParams: the typed term sheet of a structured product (Flow's
 * products/params.ts, for Solana). A product is instantiated into a BPMN
 * workflow from these parameters, never authored free-hand, so every issued
 * note runs one of a small set of tested payoff engines.
 *
 * Units: one note unit has a face value of 1 unit of the cash token (USDC).
 * Percentages are of face (coupons, protection) or of the strike (barriers,
 * autocall level). Settlement is in cash: below the knock-in barrier a holder
 * receives final / strike per unit.
 */

export type ProductType = 'fcn' | 'reverse-convertible' | 'phoenix' | 'snowball' | 'ppn';

export interface ProductParams {
  productType: ProductType;
  name: string;
  /** Subscription price in % of face (100 = par). */
  issuePricePct: number;
  underlying: {
    symbol: string;
    /** Chainlink price feed (EVM AggregatorV3) the CRE workflow reads. */
    feed: string;
    /** CRE chain selector name of the feed's chain. */
    feedChain: string;
    /** Bounds every observed price must sit in (checked on-chain). */
    minPrice: number;
    maxPrice: number;
  };
  /** Number of observations per issuance; the last one is maturity. Dates are set per issuance at pre-trade. */
  observations: number;
  couponRatePct?: number;
  couponBarrierPct?: number;
  memory?: boolean;
  autocallLevelPct?: number;
  autocallFromPeriod?: number;
  knockInBarrierPct?: number;
  protectionPct?: number;
  participationPct?: number;
}

export const PRODUCT_LABELS: Record<ProductType, string> = {
  'fcn': 'Fixed Coupon Note',
  'reverse-convertible': 'Reverse Convertible',
  'phoenix': 'Phoenix Autocallable',
  'snowball': 'Snowball Autocallable',
  'ppn': 'Principal-Protected Note',
};

export function productUses(t: ProductType) {
  return {
    coupon: t !== 'ppn',
    couponBarrier: t === 'phoenix',
    autocall: t === 'fcn' || t === 'phoenix' || t === 'snowball',
    knockIn: t !== 'ppn',
    protection: t === 'ppn',
  };
}

export const MAX_OBSERVATIONS = 12;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

export function validateProductParams(p: ProductParams): string[] {
  const e: string[] = [];
  const use = productUses(p.productType);
  if (!PRODUCT_LABELS[p.productType]) e.push(`Unknown product type '${p.productType}'.`);
  if (!p.name?.trim()) e.push('Give the product a name.');
  if (!(p.issuePricePct > 0)) e.push('Issue price must be positive (% of face).');
  if (!p.underlying?.symbol?.trim()) e.push('Name the underlying.');
  if (!EVM_ADDR.test(p.underlying?.feed || '')) e.push('The price feed must be a Chainlink feed address (0x…).');
  if (!(p.underlying?.minPrice >= 0 && p.underlying.maxPrice > p.underlying.minPrice)) e.push('Price bounds need 0 <= min < max.');
  if (!(Number.isInteger(p.observations) && p.observations >= 1 && p.observations <= MAX_OBSERVATIONS)) e.push(`Between 1 and ${MAX_OBSERVATIONS} observations.`);
  if (use.coupon && !(Number(p.couponRatePct) > 0)) e.push('Set a positive coupon rate per period.');
  if (use.couponBarrier && !(Number(p.couponBarrierPct) > 0)) e.push('A phoenix needs a coupon barrier (% of strike).');
  if (use.autocall) {
    if (!(Number(p.autocallLevelPct) > 0)) e.push('Set the autocall level (% of strike).');
    const from = p.autocallFromPeriod ?? 1;
    if (!(Number.isInteger(from) && from >= 1 && from <= p.observations)) e.push('The first autocall observation must be within the schedule.');
  }
  if (use.knockIn) {
    if (!(Number(p.knockInBarrierPct) > 0)) e.push('Set the knock-in barrier (% of strike).');
    if (use.autocall && Number(p.knockInBarrierPct) >= Number(p.autocallLevelPct)) e.push('The knock-in barrier must be below the autocall level.');
    if (use.couponBarrier && Number(p.knockInBarrierPct) > Number(p.couponBarrierPct)) e.push('The knock-in barrier must not be above the coupon barrier.');
  }
  if (use.protection) {
    if (!(Number(p.protectionPct) > 0 && Number(p.protectionPct) <= 100)) e.push('Protection must be between 0 and 100% of face.');
    if (!(Number(p.participationPct) >= 0)) e.push('Participation must be zero or positive.');
  }
  return e;
}

/** Worst-case extra cash per unit beyond par the issuer must hold for coupons (bounded products). */
export function reservePerUnit(p: ProductParams): number | null {
  const r = (p.couponRatePct ?? 0) / 100;
  if (p.productType === 'ppn') return null; // participation is uncapped: the issuer sizes it
  if (p.productType === 'snowball') return r * p.observations;
  return r * p.observations;
}

// Chainlink ETH/USD and BTC/USD on Ethereum mainnet (8 decimals).
export const FEEDS = {
  ETH: { symbol: 'ETH', feed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', feedChain: 'ethereum-mainnet', minPrice: 1, maxPrice: 1_000_000 },
  BTC: { symbol: 'BTC', feed: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', feedChain: 'ethereum-mainnet', minPrice: 1, maxPrice: 10_000_000 },
  SOL: { symbol: 'SOL', feed: '0x4ffC43a60e009B551865A93d232E33Fce9f01507', feedChain: 'ethereum-mainnet', minPrice: 0.01, maxPrice: 100_000 },
};

const base = { issuePricePct: 100, underlying: FEEDS.ETH, observations: 4 };

/** One worked example per product (quarterly over a year on ETH/USD). */
export const EXAMPLE_PRODUCTS: Record<ProductType, ProductParams> = {
  'fcn': { ...base, productType: 'fcn', name: '12M Fixed Coupon Note on ETH', couponRatePct: 2, autocallLevelPct: 100, knockInBarrierPct: 60 },
  'reverse-convertible': { ...base, productType: 'reverse-convertible', name: '12M Reverse Convertible on ETH', couponRatePct: 2.5, knockInBarrierPct: 70 },
  'phoenix': { ...base, productType: 'phoenix', name: '12M Phoenix (memory) on ETH', couponRatePct: 2.5, couponBarrierPct: 70, memory: true, autocallLevelPct: 100, autocallFromPeriod: 2, knockInBarrierPct: 60 },
  'snowball': { ...base, productType: 'snowball', name: '12M Snowball on ETH', couponRatePct: 2.25, autocallLevelPct: 100, knockInBarrierPct: 65 },
  'ppn': { ...base, productType: 'ppn', name: '12M 100% Protected Note on ETH', observations: 1, protectionPct: 100, participationPct: 50 },
};
