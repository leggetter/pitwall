// Timing bounds for the tests that guard against slow paths on hostile input (W149). A fixed bound in
// milliseconds failed on CI's shared runners whenever another test file kept the machine busy, as the
// #uikit gallery's tests do. These measure the hostile run against a comparison run, in turn with it,
// so a busy machine slows both and the bound grows with it, up to a ceiling. The comparison has to be
// one the slow path can't slow too: an ordinary input of the same size, where only the hostile input
// reaches the slow path, or the same work at a quarter of the size, where the slow path scales worse.

/**
 * The best time of each function in milliseconds, over `runs` rounds that call each in turn. Calling
 * them in turn puts a spell of load on every function alike; taking the best of each drops a pause that
 * hits one call.
 */
export function bestTimes(fns: readonly (() => unknown)[], runs = 5): number[] {
  const best = fns.map(() => Number.POSITIVE_INFINITY);
  for (let run = 0; run < runs; run++) {
    fns.forEach((fn, i) => {
      const start = performance.now();
      fn();
      best[i] = Math.min(best[i]!, performance.now() - start);
    });
  }
  return best;
}

export interface SlowBound {
  /** The bound on a quiet machine, such as a frame. */
  floorMs: number;
  /** On a slower machine, this many times the comparison run's best time, when that's more. */
  ratio: number;
  /** Never more than this, so a slow path the comparison shares, such as one in all parsing, still fails. */
  ceilingMs: number;
}

/** The bound for a hostile run, given the comparison run's best time. */
export function slowBound(comparisonMs: number, { floorMs, ratio, ceilingMs }: SlowBound): number {
  return Math.min(ceilingMs, Math.max(floorMs, ratio * comparisonMs));
}
