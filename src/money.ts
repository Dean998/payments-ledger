import { z } from 'zod';

/** ISO 4217 code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code such as USD');

/**
 * Amounts cross the API as integers in minor units (cents), never as floats.
 * Internally all arithmetic is done in bigint.
 */
export const MinorUnits = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function toApiAmount(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`amount ${value} cannot be represented safely as a JSON number`);
  }
  return Number(value);
}

/** pg returns BIGINT columns as strings; this keeps the conversion in one place. */
export function fromDb(value: string | number | bigint | null | undefined): bigint {
  return value === null || value === undefined ? 0n : BigInt(value);
}

export function formatMinor(value: bigint | number, currency: string): string {
  const v = BigInt(value);
  const sign = v < 0n ? '-' : '';
  const abs = v < 0n ? -v : v;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}
