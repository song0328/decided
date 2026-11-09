// Charge client for the PSP (payment service provider).

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Charge a card through the PSP, retrying when the call fails.
 * @param {{ chargeOnce: (req: object) => Promise<object> }} psp
 * @param {{ amountMinor: number, currency: string, cardToken: string, idempotencyKey: string }} req
 * @param {{ sleep?: (ms: number) => Promise<void> }} [opts]
 */
export async function charge(psp, req, { sleep: wait = sleep } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await psp.chargeOnce(req);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) await wait(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

export class PspError extends Error {
  /** @param {string} message @param {{ kind: 'timeout' | 'http' | 'decline', status?: number, code?: string }} info */
  constructor(message, info) {
    super(message);
    this.kind = info.kind;
    this.status = info.status;
    this.code = info.code;
  }
}
