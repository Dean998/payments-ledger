/**
 * Expected business failures. They carry an HTTP status and a stable,
 * machine-readable code. Anything that is not a DomainError is a bug or an
 * infrastructure failure and becomes a 500.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toResponse() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}

export const errors = {
  notFound: (what: string, id: string) =>
    new DomainError('not_found', `${what} ${id} not found`, 404),
  validation: (message: string, details?: Record<string, unknown>) =>
    new DomainError('validation_error', message, 400, details),
  insufficientFunds: (accountId: string, available: bigint, requested: bigint) =>
    new DomainError(
      'insufficient_funds',
      `account ${accountId} has insufficient available funds`,
      422,
      {
        accountId,
        available: Number(available),
        requested: Number(requested),
      },
    ),
  currencyMismatch: (expected: string, actual: string) =>
    new DomainError('currency_mismatch', `expected currency ${expected}, got ${actual}`, 422),
  unbalancedEntry: (currency: string, net: bigint) =>
    new DomainError('unbalanced_entry', `entry does not balance in ${currency} (net ${net})`, 422),
  invalidTransition: (entity: string, from: string, to: string) =>
    new DomainError(
      'invalid_state_transition',
      `${entity} cannot move from ${from} to ${to}`,
      409,
      { from, to },
    ),
  idempotencyKeyReused: () =>
    new DomainError(
      'idempotency_key_reused',
      'this Idempotency-Key was already used with a different request body',
      422,
    ),
};
