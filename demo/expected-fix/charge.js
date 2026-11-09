// Charge client for the PSP (payment service provider).
// Retry policy follows team decisions D-1 (max 3 retries, exponential backoff),
// D-2 (never retry hard declines) and D-3 (whole sequence within 30 s) — see Decided in Jira.

const MAX_RETRIES = 3; // D-1
const BASE_DELAY_MS = 1000; // 1 s, 2 s, 4 s
const TOTAL_BUDGET_MS = 30_000; // D-3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only network timeouts and PSP 5xx are worth retrying; card declines never are (D-2). */
export function isRetryable(err) {
  if (!(err instanceof PspError)) return false;
  if (err.kind === 'timeout') return true;
  return err.kind === 'http' && err.status >= 500;
}

/**
 * Charge a card through the PSP, retrying transient failures.
 * @param {{ chargeOnce: (req: object) => Promise<object> }} psp
 * @param {{ amountMinor: number, currency: string, cardToken: string, idempotencyKey: string }} req
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number }} [opts]
 */
export async function charge(psp, req, { sleep: wait = sleep, now = Date.now } = {}) {
  const started = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await psp.chargeOnce(req);
    } catch (err) {
      const delay = BASE_DELAY_MS * 2 ** attempt;
      const outOfTime = now() - started + delay > TOTAL_BUDGET_MS;
      if (!isRetryable(err) || attempt >= MAX_RETRIES || outOfTime) throw err;
      await wait(delay);
    }
  }
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
