/** The boundary to the bank. A real implementation would build NACHA files and talk SFTP or an API. */

export interface AchSubmission {
  transferId: string;
  type: 'ach_push' | 'ach_pull';
  amount: bigint;
  currency: string;
  routingNumber: string;
  accountNumber: string;
  holderName: string;
}

export interface AchReceipt {
  transferId: string;
  bankReference: string;
}

export interface AchTrackedTransfer {
  transferId: string;
  bankReference: string;
  amount: bigint;
  status: 'submitted' | 'settled';
  submittedAt: Date;
}

export type AchUpdate =
  | { transferId: string; kind: 'settled' }
  | { transferId: string; kind: 'returned'; returnCode: string; returnReason: string };

export interface AchNetwork {
  /** Must be idempotent on batchId: sending the same batch twice returns the same receipts. */
  submitBatch(batchId: string, items: AchSubmission[]): Promise<AchReceipt[]>;
  /** Status changes for in-flight transfers. Duplicates are allowed; callers apply them idempotently. */
  fetchUpdates(items: AchTrackedTransfer[], now: Date): Promise<AchUpdate[]>;
}
