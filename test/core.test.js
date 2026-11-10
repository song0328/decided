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

import { DEMO, demoStep } from '../src/core.js';

test('demo quotes really appear in the demo comments', () => {
  const retry = DEMO.issues.find((i) => i.ref === 'retry');
  const text = [retry.summary, retry.description, ...retry.comments].join('\n');
  for (const c of DEMO.candidates) assert.equal(quoteFound(c.quote, text), true, c.key);
  assert.equal(quoteFound(DEMO.change.quote, DEMO.change.comment), true);
  assert.equal(quoteFound(DEMO.change.quote, text), false); // not there until step 2
});
test('demo steps', () => {
  assert.equal(demoStep(null), 'start');
  const st = { issues: { retry: 'X-1' }, capId: 'D-1' };
  assert.equal(demoStep(st, [{ id: 'D-1', status: STATUS.CANDIDATE }]), 'promote');
  assert.equal(demoStep(st, [{ id: 'D-1', status: STATUS.PROMOTED, scope: 'issue' }]), 'use');
  assert.equal(demoStep({ ...st, used: true }, [{ id: 'D-1', status: STATUS.PROMOTED, scope: 'issue' }]), 'team');
  assert.equal(demoStep({ ...st, used: true }, [{ id: 'D-1', status: STATUS.PROMOTED, scope: 'team' }]), 'change');
  assert.equal(demoStep({ ...st, changed: true }, []), 'done');
});

import { isSelfPromotion, projectLog } from '../src/core.js';

test('self-promotion only for human-entered candidates by the same person', () => {
  assert.equal(isSelfPromotion({ origin: ORIGIN.HUMAN, proposedBy: 'u1' }, 'u1'), true);
  assert.equal(isSelfPromotion({ origin: ORIGIN.HUMAN, proposedBy: 'u1' }, 'u2'), false);
  assert.equal(isSelfPromotion({ origin: ORIGIN.AI, proposedBy: 'u1' }, 'u1'), false);
  assert.match(formatForAgent({ ...ds[1], selfPromoted: true }), /not reviewed by a second person/);
});
test('project log groups by status and project', () => {
  const log = projectLog([
    { id: 'D-1', issueKey: 'PAY-1', status: STATUS.PROMOTED, promotedAt: 1, selfPromoted: true },
    { id: 'D-2', issueKey: 'PAY-2', status: STATUS.PROMOTED, promotedAt: 2 },
    { id: 'D-3', issueKey: 'PAYX-1', status: STATUS.PROMOTED },
    { id: 'D-4', issueKey: 'PAY-1', status: STATUS.SUPERSEDED },
    { id: 'D-5', issueKey: 'PAY-3', status: STATUS.STALE },
  ], 'PAY');
  assert.deepEqual(log.current.map((d) => d.id), ['D-2', 'D-1']);
  assert.equal(log.history.length, 1);
  assert.equal(log.review.length, 1);
  assert.equal(log.selfPromoted, 1);
});

import { projectOf, sameProject } from '../src/core.js';

test('conflicts and pickers stay inside one Jira project', () => {
  assert.equal(projectOf('PAY-12'), 'PAY');
  assert.equal(projectOf('NPAY-1'), 'NPAY');
  assert.equal(projectOf('nope'), '');
  const ds = [{ id: 'D-1', issueKey: 'NPAY-1' }, { id: 'D-2', issueKey: 'PAY-6' }];
  assert.deepEqual(sameProject(ds, 'PAY-9').map((d) => d.id), ['D-2']);
  assert.equal(sameProject(ds, '').length, 2);
});

import { SCOPE, scopeOf, nextScope, usage, promotionChecks, inScopeFor } from '../src/core.js';

test('promotion ladder: scope order and legacy decisions', () => {
  assert.equal(scopeOf({}), SCOPE.TEAM);
  assert.equal(nextScope({ scope: 'issue' }), 'team');
  assert.equal(nextScope({ scope: 'team' }), 'org');
  assert.equal(nextScope({ scope: 'org' }), null);
});
test('usage counts other issues and other projects', () => {
  const u = usage({ issueKey: 'PAY-6' }, [{ issueKey: 'PAY-6' }, { issueKey: 'PAY-7' }, { issueKey: 'PAY-7' }, { issueKey: 'SHOP-3' }]);
  assert.equal(u.issues, 2);
  assert.deepEqual(u.otherProjects, ['SHOP']);
});
test('issue -> team needs evidence or a second person', () => {
  const d = { status: STATUS.PROMOTED, scope: 'issue', quoteVerified: true, promotedBy: 'u1', issueKey: 'PAY-6' };
  let c = promotionChecks(d, { issues: 0, otherProjects: [] }, 'u1');
  assert.equal(c.target, 'team'); assert.equal(c.allowed, false);
  c = promotionChecks(d, { issues: 2, otherProjects: [] }, 'u1');
  assert.equal(c.allowed, true); assert.equal(c.suggested, true);
  c = promotionChecks(d, { issues: 0, otherProjects: [] }, 'u2');
  assert.equal(c.allowed, true); assert.equal(c.suggested, false);
  assert.equal(promotionChecks({ ...d, quoteVerified: false }, { issues: 5, otherProjects: [] }, 'u2').allowed, false);
});
test('team -> org needs use outside the project or a second person', () => {
  const d = { status: STATUS.PROMOTED, scope: 'team', quoteVerified: true, promotedBy: 'u1', scopeBy: 'u2', issueKey: 'PAY-6' };
  assert.equal(promotionChecks(d, { issues: 9, otherProjects: [] }, 'u2').allowed, false);
  assert.equal(promotionChecks(d, { issues: 0, otherProjects: ['SHOP'] }, 'u2').allowed, true);
});
test('agents get org + their team + their issue', () => {
  const ds = [
    { id: 'A', scope: 'org', issueKey: 'SEC-1' },
    { id: 'B', scope: 'team', issueKey: 'PAY-1' },
    { id: 'C', scope: 'team', issueKey: 'SHOP-1' },
    { id: 'D', scope: 'issue', issueKey: 'PAY-6' },
    { id: 'E', scope: 'issue', issueKey: 'PAY-9' },
  ];
  const got = inScopeFor(ds, 'PAY-6');
  // Other teams' team decisions are visible but not binding; other issues' decisions in this project likewise.
  assert.deepEqual(got.map((d) => [d.id, d.appliesHere]), [['A', true], ['B', true], ['C', false], ['D', true], ['E', false]]);
  // Keys come in many shapes; without one, only org standards bind.
  assert.deepEqual(inScopeFor(ds, 'https://x.atlassian.net/browse/pay-6').map((d) => d.appliesHere), [true, true, false, true, false]);
  assert.deepEqual(inScopeFor(ds, '').map((d) => [d.id, d.appliesHere]), [['A', true], ['B', false], ['C', false]]);
  assert.match(formatForAgent({ ...got[4], status: STATUS.PROMOTED, statement: 'x', quote: 'q' }), /NOT a team rule yet/);
  assert.match(formatForAgent({ ...got[2], status: STATUS.PROMOTED, statement: 'x', quote: 'q' }), /TEAM DECISION of project SHOP — NOT a rule/);
  assert.match(formatForAgent({ ...ds[1], status: STATUS.PROMOTED, statement: 'x', quote: 'q' }), /TEAM DECISION/);
});

import { cleanPolicy } from '../src/core.js';

test('admin policy: owners only, and a required second person', () => {
  const d = { status: STATUS.PROMOTED, scope: 'issue', quoteVerified: true, promotedBy: 'u1', issueKey: 'PAY-6' };
  const used = { issues: 2, otherProjects: [] };
  assert.equal(promotionChecks(d, used, 'u1', { owners: ['lead'] }).allowed, false);
  assert.equal(promotionChecks(d, used, 'lead', { owners: ['lead'] }).allowed, true);
  assert.equal(promotionChecks(d, used, 'u1', { requireSecondPerson: true }).allowed, false);
  assert.equal(promotionChecks(d, used, 'u2', { requireSecondPerson: true }).allowed, true);
  assert.ok(promotionChecks(d, used, 'u1', { owners: ['lead'] }).checks.some((c) => c.key === 'owner' && !c.ok));
});
test('cleanPolicy accepts picker objects and drops junk', () => {
  assert.deepEqual(cleanPolicy({ owners: [{ id: 'a' }, 'b', 'b', null, 5], requireSecondPerson: 'yes' }), { owners: ['a', 'b'], requireSecondPerson: true });
  assert.deepEqual(cleanPolicy(), { owners: [], requireSecondPerson: false });
});

import { strongMatch } from '../src/core.js';

test('only a real match counts as use', () => {
  const d = { title: 'Retry sequence duration', statement: 'The whole retry sequence must finish within 30 seconds so the checkout page never times out.' };
  assert.equal(strongMatch(d, 'retry logic in the charge client'), true); // title word
  assert.equal(strongMatch(d, 'button colour on the settings page'), false); // one shared word in the body
  assert.equal(strongMatch(d, 'checkout page timeouts'), true); // two body words
});
