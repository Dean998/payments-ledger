import type {
  AchNetwork,
  AchReceipt,
  AchSubmission,
  AchTrackedTransfer,
  AchUpdate,
} from './network.js';

/**
 * Magic cent values trigger returns, so every path can be demoed and tested:
 * an amount of 100.01 returns with R01, 250.10 settles and then gets a late R10.
 */
export const RETURN_SCENARIOS: Record<number, { code: string; reason: string; late: boolean }> = {
  1: { code: 'R01', reason: 'Insufficient funds', late: false },
  2: { code: 'R02', reason: 'Account closed', late: false },
  3: { code: 'R03', reason: 'No account / unable to locate account', late: false },
  10: { code: 'R10', reason: 'Customer advises not authorized', late: true },
  29: { code: 'R29', reason: 'Corporate customer advises not authorized', late: true },
};

export interface MockAchNetworkOptions {
  settleAfterMs: number;
  lateReturnAfterMs: number;
}

/**
 * A stateless, deterministic bank. Outcomes depend only on the amount and
 * the time since submission, so the worker can restart freely and tests can
 * fast-forward time by passing `now`.
 */
export class MockAchNetwork implements AchNetwork {
  constructor(private readonly opts: MockAchNetworkOptions) {}

  submitBatch(batchId: string, items: AchSubmission[]): Promise<AchReceipt[]> {
    return Promise.resolve(
      items.map((i) => ({
        transferId: i.transferId,
        bankReference: `MOCK-${batchId.slice(0, 8)}-${i.transferId.slice(0, 8)}`.toUpperCase(),
      })),
    );
  }

  fetchUpdates(items: AchTrackedTransfer[], now: Date): Promise<AchUpdate[]> {
    const updates: AchUpdate[] = [];
    for (const item of items) {
      const scenario = RETURN_SCENARIOS[Number(item.amount % 100n)];
      const elapsed = now.getTime() - item.submittedAt.getTime();
      if (item.status === 'submitted') {
        if (scenario && !scenario.late && elapsed >= this.opts.settleAfterMs / 2) {
          updates.push({
            transferId: item.transferId,
            kind: 'returned',
            returnCode: scenario.code,
            returnReason: scenario.reason,
          });
        } else if (elapsed >= this.opts.settleAfterMs) {
          updates.push({ transferId: item.transferId, kind: 'settled' });
        }
      } else if (scenario?.late && elapsed >= this.opts.lateReturnAfterMs) {
        updates.push({
          transferId: item.transferId,
          kind: 'returned',
          returnCode: scenario.code,
          returnReason: scenario.reason,
        });
      }
    }
    return Promise.resolve(updates);
  }
}
