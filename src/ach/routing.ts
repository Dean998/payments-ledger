/**
 * ABA routing numbers carry a checksum:
 * 3(d1 + d4 + d7) + 7(d2 + d5 + d8) + (d3 + d6 + d9) ≡ 0 (mod 10).
 * Catching typos here avoids an R03/R04 return days later.
 */
export function isValidRoutingNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}
