// A stand-in cost for the usage report (W131): Anthropic's API list prices per model. How a
// subscription plan's usage limits weigh tokens isn't published, so this is only a way to weigh
// cache reads, cache writes, fresh input and output against each other in one figure.

/** USD per million tokens. */
export interface Rates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface ModelPrice extends Rates {
  /** Fast mode's price as a multiple of the standard one, where the model has fast mode. */
  fastMultiplier?: number;
  /** Higher rates for a request whose prompt (input, cache writes and cache reads) is over `over` tokens. */
  longPrompt?: { over: number; rates: Rates };
}

export const COST_LABEL = "API list price, a stand-in: how your plan's usage limits weigh tokens isn't published";

// From Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing,
// fetched 2026-11-02: "Model pricing" (base input, 5m cache writes, 1h cache writes, cache hits and
// refreshes, output), "Fast mode pricing" (Opus 5.5 $8/$40, Opus 5 and Opus 4.8 $10/$50, with the
// caching multipliers on top, so 2x every rate), "Long context pricing" (Haiku 5.5 over 100,000
// prompt tokens) and "Data residency" (US-only inference_geo is 1.1x on 4.6 and later models).
const rates = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): Rates => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
});

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': rates(10, 12.5, 20, 0.25, 50),
  'claude-mythos-5-1': rates(10, 12.5, 20, 0.25, 50),
  'claude-fable-5': rates(10, 12.5, 20, 1, 50),
  'claude-mythos-5': rates(10, 12.5, 20, 1, 50),
  'claude-opus-5-5': { ...rates(4, 5, 8, 0.2, 20), fastMultiplier: 2 },
  'claude-opus-5': { ...rates(5, 6.25, 10, 0.5, 25), fastMultiplier: 2 },
  'claude-opus-4-8': { ...rates(5, 6.25, 10, 0.5, 25), fastMultiplier: 2 },
  'claude-opus-4-7': rates(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-6': rates(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-5': rates(5, 6.25, 10, 0.5, 25),
  'claude-opus-4-1': rates(15, 18.75, 30, 1.5, 75),
  'claude-opus-4': rates(15, 18.75, 30, 1.5, 75),
  'claude-sonnet-5-5': rates(2, 2.5, 4, 0.1, 10),
  'claude-sonnet-5': rates(2, 2.5, 4, 0.2, 10),
  'claude-sonnet-4-6': rates(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4-5': rates(3, 3.75, 6, 0.3, 15),
  'claude-sonnet-4': rates(3, 3.75, 6, 0.3, 15),
  'claude-haiku-5-5': { ...rates(0.1, 0.125, 0.2, 0.01, 0.5), longPrompt: { over: 100_000, rates: rates(0.5, 0.625, 1, 0.05, 2.5) } },
  'claude-haiku-4-5': rates(1, 1.25, 2, 0.1, 5),
  'claude-3-5-haiku': rates(0.8, 1, 1.6, 0.08, 4),
};

/** Models on which US-only inference costs 1.1x: Claude 4.6 and later. */
const NO_GEO_MULTIPLIER = new Set(['claude-opus-4-5', 'claude-opus-4-1', 'claude-opus-4', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-haiku-4-5', 'claude-3-5-haiku']);

/** A model id as the price table keys it: no provider prefix, no `[1m]`, no date suffix. */
export function priceKey(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/[-@]\d{8}$/, '');
}

export function priceOf(model: string): ModelPrice | undefined {
  return PRICES[priceKey(model)];
}

export interface PricedUsage {
  model: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  speed?: string | undefined;
  geo?: string | undefined;
}

/** The call's stand-in cost in USD, or undefined for a model the table doesn't know. */
export function costOf(usage: PricedUsage): number | undefined {
  const price = priceOf(usage.model);
  if (price === undefined) return undefined;
  const prompt = usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead;
  const r: Rates = price.longPrompt !== undefined && prompt > price.longPrompt.over ? price.longPrompt.rates : price;
  let multiplier = 1;
  if (usage.speed === 'fast' && price.fastMultiplier !== undefined) multiplier *= price.fastMultiplier;
  if (usage.geo === 'us' && !NO_GEO_MULTIPLIER.has(priceKey(usage.model))) multiplier *= 1.1;
  const dollars =
    usage.input * r.input + usage.cacheWrite5m * r.cacheWrite5m + usage.cacheWrite1h * r.cacheWrite1h + usage.cacheRead * r.cacheRead + usage.output * r.output;
  return (dollars / 1_000_000) * multiplier;
}
