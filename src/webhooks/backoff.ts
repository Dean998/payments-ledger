/**
 * Exponential backoff with "equal jitter": half the delay is fixed, half is
 * random. The randomness spreads out retries from many deliveries that failed
 * together (for example, a receiver outage), so they don't stampede it the
 * moment it recovers.
 */
export function backoffMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number } = {},
  random: () => number = Math.random,
): number {
  const base = opts.baseMs ?? 1_000;
  const max = opts.maxMs ?? 6 * 60 * 60 * 1_000;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}
