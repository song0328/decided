import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteFound, toPlainText, adfToText, confluencePageId, rank, formatForAgent, verifiedSuggestions, STATUS, ORIGIN,
} from '../src/core.js';

const page = '<p>Retry&nbsp;policy</p><p>We agreed: <strong>payment retries are capped at 3</strong> with exponential backoff.</p>';

test('quote found despite HTML, case and whitespace', () => {
  assert.equal(quoteFound('Payment retries are  capped at 3', toPlainText(page)), true);
});
test('changed number breaks the quote', () => {
  assert.equal(quoteFound('payment retries are capped at 5', toPlainText(page)), false);
});
test('very short quotes do not count as evidence', () => {
  assert.equal(quoteFound('at 3', toPlainText(page)), false);
});
test('smart quotes and dashes normalise', () => {
  assert.equal(quoteFound('the “owner” decides — final', 'The "owner" decides - final.'), true);
});
test('ADF to text', () => {
  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use Postgres, not Mongo.' }] }] };
  assert.match(adfToText(adf), /Use Postgres, not Mongo\./);
});
test('page id from URLs', () => {
  assert.equal(confluencePageId('https://x.atlassian.net/wiki/spaces/ENG/pages/12345/Retry+policy'), '12345');
  assert.equal(confluencePageId('https://x.atlassian.net/wiki/pages/viewpage.action?pageId=777'), '777');
  assert.equal(confluencePageId('6789'), '6789');
  assert.equal(confluencePageId('https://example.com'), null);
});
const ds = [
  { id: 'D-1', title: 'Payment retries capped at 3', statement: 'Retry failed payments at most 3 times', issueKey: 'PAY-42', status: STATUS.PROMOTED, origin: ORIGIN.AI, quote: 'capped at 3', promotedAt: 1 },
  { id: 'D-2', title: 'Use Postgres', statement: 'Orders live in Postgres', issueKey: 'ORD-7', status: STATUS.PROMOTED, origin: ORIGIN.HUMAN, quote: 'Use Postgres', promotedAt: 2 },
];
test('rank finds the relevant decision', () => {
  const r = rank(ds, 'change the payment retry logic');
  assert.equal(r[0].id, 'D-1');
  assert.equal(r.length, 1);
});
test('agent format warns on stale', () => {
  assert.match(formatForAgent({ ...ds[0], status: STATUS.STALE }), /NEEDS REVIEW/);
  assert.match(formatForAgent(ds[0]), /AI-proposed, human-promoted/);
});
test('LLM suggestions keep only verified quotes', () => {
  const raw = 'Here you go: [{"title":"Cap retries","statement":"Retries capped at 3","quote":"payment retries are capped at 3"},{"title":"Fake","statement":"x","quote":"we will use kafka for everything"}]';
  const out = verifiedSuggestions(raw, toPlainText(page));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Cap retries');
  assert.deepEqual(verifiedSuggestions('not json', page), []);
});

import { relatedDecisions, parseConflictIds, latestInChain, history, reliantIssues, recheckComment, overlap } from '../src/core.js';

const d12 = { id: 'D-12', title: 'Payment retries capped at 3', statement: 'Retry failed payments at most 3 times', status: STATUS.PROMOTED, supersededBy: '' };
const dOther = { id: 'D-20', title: 'Use Postgres for orders', statement: 'Orders live in Postgres', status: STATUS.PROMOTED };
const dOld = { id: 'D-5', title: 'Payment retries capped at 2', statement: 'Retry payments twice', status: STATUS.SUPERSEDED, supersededBy: 'D-12' };

test('related decisions: same topic found, other topics and history ignored', () => {
  const cand = { id: 'D-31', title: 'Payment retries capped at 5', statement: 'Retry failed payments up to 5 times' };
  const r = relatedDecisions(cand, [d12, dOther, dOld]);
  assert.deepEqual(r.map((d) => d.id), ['D-12']);
  assert.ok(overlap('payment retries', 'postgres orders') === 0);
  assert.equal(overlap('retry policy', 'payment retries'), 0.5);
});
test('conflict ids only from offered list', () => {
  assert.deepEqual(parseConflictIds('Contradicts: ["D-12","D-99"]', ['D-12', 'D-20']), ['D-12']);
  assert.deepEqual(parseConflictIds('none', ['D-12']), []);
});
test('supersede chain: latest and history', () => {
  const d31 = { id: 'D-31', supersedes: 'D-12', status: STATUS.PROMOTED };
  const byId = new Map([dOld, { ...d12, supersedes: 'D-5', supersededBy: 'D-31', status: STATUS.SUPERSEDED }, d31].map((d) => [d.id, d]));
  assert.equal(latestInChain('D-5', byId).id, 'D-31');
  assert.deepEqual(history('D-12', byId).map((d) => d.id), ['D-5', 'D-12', 'D-31']);
});
test('supersede chain survives a cycle', () => {
  const byId = new Map([['A', { id: 'A', supersededBy: 'B', supersedes: 'B' }], ['B', { id: 'B', supersededBy: 'A', supersedes: 'A' }]]);
  assert.ok(latestInChain('A', byId));
  assert.ok(history('A', byId).length <= 2);
});
test('reliant issues: one row per issue, newest first, excluding the source issue', () => {
  const rs = [
    { issueKey: 'PAY-50', at: 1 }, { issueKey: 'PAY-50', at: 5 }, { issueKey: 'PAY-61', at: 3 }, { issueKey: 'PAY-42', at: 9 },
  ];
  assert.deepEqual(reliantIssues(rs, 'PAY-42').map((r) => [r.issueKey, r.at]), [['PAY-50', 5], ['PAY-61', 3]]);
});
test('recheck comment names old and new decision', () => {
  const c = recheckComment(d12, { id: 'D-31', statement: 'Retry up to 5 times' }, 'new PSP limits');
  assert.match(c, /D-12/); assert.match(c, /D-31/); assert.match(c, /new PSP limits/);
  assert.match(recheckComment(d12, null), /quoted text changed/);
});
