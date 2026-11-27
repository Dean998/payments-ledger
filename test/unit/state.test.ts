import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  eventTypeFor,
  initialStatus,
  isTerminal,
} from '../../src/transfers/state.js';

describe('transfer state machine', () => {
  it('book transfers are terminal at creation', () => {
    expect(initialStatus('book')).toBe('posted');
    expect(isTerminal('book', 'posted')).toBe(true);
    expect(canTransition('book', 'posted', 'returned')).toBe(false);
  });

  it.each([
    ['pending', 'submitted'],
    ['pending', 'canceled'],
    ['submitted', 'settled'],
    ['submitted', 'returned'],
    ['settled', 'returned'],
  ] as const)('ACH allows %s -> %s', (from, to) => {
    expect(canTransition('ach_pull', from, to)).toBe(true);
  });

  it.each([
    ['pending', 'settled'],
    ['submitted', 'canceled'],
    ['returned', 'settled'],
    ['canceled', 'pending'],
    ['settled', 'submitted'],
  ] as const)('ACH forbids %s -> %s', (from, to) => {
    expect(() => assertTransition('ach_push', from, to)).toThrow(/cannot move/);
  });

  it('names events after the status', () => {
    expect(eventTypeFor('pending')).toBe('transfer.created');
    expect(eventTypeFor('returned')).toBe('transfer.returned');
  });
});
