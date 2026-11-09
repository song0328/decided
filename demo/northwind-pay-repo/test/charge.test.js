import test from 'node:test';
import assert from 'node:assert/strict';
import { charge, PspError } from '../src/charge.js';

const req = { amountMinor: 1299, currency: 'EUR', cardToken: 'tok_demo', idempotencyKey: 'idem-1' };
const noWait = { sleep: async () => {} };

function fakePsp(outcomes) {
  const calls = [];
  return {
    calls,
    async chargeOnce(r) {
      calls.push(r);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('returns the PSP result on first success', async () => {
  const psp = fakePsp([{ id: 'ch_1', status: 'succeeded' }]);
  assert.deepEqual(await charge(psp, req, noWait), { id: 'ch_1', status: 'succeeded' });
  assert.equal(psp.calls.length, 1);
});

test('retries a timeout and then succeeds', async () => {
  const psp = fakePsp([new PspError('timeout', { kind: 'timeout' }), { id: 'ch_2', status: 'succeeded' }]);
  assert.equal((await charge(psp, req, noWait)).id, 'ch_2');
  assert.equal(psp.calls.length, 2);
});
