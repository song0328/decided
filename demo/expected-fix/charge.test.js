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

test('D-1: at most 3 retries with exponential backoff', async () => {
  const waits = [];
  const t = new PspError('timeout', { kind: 'timeout' });
  const psp = fakePsp([t, t, t, t, { id: 'never' }]);
  await assert.rejects(charge(psp, req, { sleep: async (ms) => { waits.push(ms); } }));
  assert.equal(psp.calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('D-2: hard declines are never retried', async () => {
  const psp = fakePsp([new PspError('insufficient funds', { kind: 'decline', code: 'insufficient_funds' })]);
  await assert.rejects(charge(psp, req, noWait));
  assert.equal(psp.calls.length, 1);
});
