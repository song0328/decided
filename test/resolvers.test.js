// End-to-end tests of the resolvers, MCP actions and trigger, against an in-memory Forge (KVS) and Jira/Confluence.
// Run with: node --test --experimental-test-module-mocks
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------- in-memory Forge KVS with the manifest's indexes ----------
const INDEX = {
  decision: { 'by-issue': 'issueKey', 'by-status': 'status', 'by-page': 'sourcePageId' },
  reliance: { 'by-decision': 'decisionId', 'by-issue': 'issueKey' },
};
let db;
function entity(name) {
  const t = (db.entities[name] ||= new Map());
  return {
    get: async (k) => (t.has(k) ? structuredClone(t.get(k)) : undefined),
    set: async (k, v) => { t.set(k, structuredClone(v)); },
    delete: async (k) => { t.delete(k); },
    query: () => {
      let filter = () => true;
      const q = {
        index: (idx, { partition }) => { const attr = INDEX[name][idx]; filter = (v) => v[attr] === partition[0]; return q; },
        limit: () => q,
        cursor: () => q,
        getMany: async () => ({ results: [...t.entries()].filter(([, v]) => filter(v)).map(([key, value]) => ({ key, value: structuredClone(value) })) }),
      };
      return q;
    },
  };
}
const kvs = {
  get: async (k) => db.kv.get(k),
  set: async (k, v) => { db.kv.set(k, structuredClone(v)); },
  entity,
};

// ---------- fake Jira / Confluence ----------
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
let site;
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
async function request(path, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  const [p, qs] = path.split('?');
  let m;
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)$/)) && method === 'GET') {
    const i = site.issues[m[1]];
    return i ? json(200, { key: m[1], fields: { summary: i.summary, description: adf(i.description) } }) : json(404, {});
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)\/comment$/))) {
    const i = site.issues[m[1]];
    if (method === 'POST') { i.comments.push(body.body.content.map((c) => c.content[0].text).join('\n')); return json(201, {}); }
    return json(200, { comments: i.comments.map((c) => ({ author: { displayName: 'Ana' }, body: adf(c) })) });
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/([A-Z0-9]+-\d+)\/properties\/decided-recheck$/))) {
    if (method === 'PUT') { site.props[m[1]] = body; return json(204); }
    return site.props[m[1]] ? json(200, { value: site.props[m[1]] }) : json(404, {});
  }
  if (p === '/rest/api/3/user') return json(200, { displayName: `User ${new URLSearchParams(qs).get('accountId')}` });
  if (p === '/rest/api/3/search/jql') {
    const proj = /project = "([A-Z0-9]+)"/.exec(decodeURIComponent(new URLSearchParams(qs).get('jql') || ''))?.[1];
    const issues = Object.keys(site.props).filter((k) => k.startsWith(`${proj}-`) && site.props[k].recheck === 'yes').map((key) => ({ key, fields: { summary: site.issues[key].summary } }));
    return json(200, { issues });
  }
  if ((m = p.match(/^\/rest\/api\/3\/issue\/createmeta\/([A-Z0-9]+)\/issuetypes$/))) return json(200, { issueTypes: [{ id: '10001', name: 'Task', subtask: false, hierarchyLevel: 0 }] });
  if (p === '/rest/api/3/issue' && method === 'POST') {
    const proj = body.fields.project.key;
    const n = Object.keys(site.issues).filter((k) => k.startsWith(`${proj}-`)).length + 1;
    const key = `${proj}-${n}`;
    site.issues[key] = { summary: body.fields.summary, description: body.fields.description.content[0].content[0].text, comments: [] };
    return json(201, { key });
  }
  if ((m = p.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/))) {
    const pg = site.pages[m[1]];
    return pg ? json(200, { title: pg.title, body: { storage: { value: pg.html } } }) : json(404, {});
  }
  throw new Error(`unmocked ${method} ${path}`);
}
const client = { requestJira: request, requestConfluence: request };
const route = (strings, ...vals) => strings.reduce((s, str, i) => s + str + (i < vals.length ? String(vals[i]) : ''), '');

class Resolver {
  constructor() { this.fns = {}; }
  define(name, fn) { this.fns[name] = fn; }
  getDefinitions() { return this.fns; }
}

mock.module('@forge/kvs', { exports: { kvs } });
mock.module('@forge/api', { exports: { asApp: () => client, asUser: () => client, route } });
mock.module('@forge/resolver', { exports: { default: Resolver } });
const app = await import('../src/index.js');
const call = (name, payload, accountId = 'u-ana') => app.handler[name]({ payload, context: { accountId } });

beforeEach(() => {
  db = { kv: new Map(), entities: {} };
  site = {
    props: {},
    pages: { 77: { title: 'Payments sync', html: '<p>We agreed payment retries are capped at 3 with exponential backoff.</p>' } },
    issues: {
      'PAY-1': { summary: 'Retries', description: 'Retry policy', comments: ['We agreed payment retries are capped at 3 with exponential backoff.'] },
      'PAY-2': { summary: 'Charge client', description: 'Fix retries', comments: [] },
      'PAY-3': { summary: 'Checkout copy', description: 'Still trying', comments: [] },
      'SHOP-1': { summary: 'Shop retries', description: 'Other team', comments: [] },
    },
  };
});

const cap = { issueKey: 'PAY-1', statement: 'Payment retries are capped at 3.', quote: 'We agreed payment retries are capped at 3 with exponential backoff.' };

test('a candidate is verified against the source and becomes an Issue decision when promoted', async () => {
  const d = await call('add', cap);
  assert.equal(d.status, 'candidate');
  assert.equal(d.quoteVerified, true);
  assert.equal(d.id, 'D-1');
  const p = await call('promote', { id: d.id });
  assert.equal(p.scope, 'issue');
  assert.equal(p.selfPromoted, true);
  const bad = await call('add', { ...cap, quote: 'We agreed payment retries are capped at 9 forever.' });
  assert.equal(bad.quoteVerified, false);
  await assert.rejects(call('promote', { id: bad.id }), /quote was not found/);
});

test('the ladder: Team needs real use or a second person, and admins can require owners', async () => {
  const d = await call('add', cap);
  await call('promote', { id: d.id });
  await assert.rejects(call('promoteScope', { id: d.id }), /cannot become a team decision yet/);

  // Agents working on two other issues look it up over MCP: it is shown as "not a team rule yet", and the use is recorded.
  const answer = await app.findDecisions({ topic: 'payment retries', issueKey: 'PAY-2' });
  assert.match(answer, /NOT a team rule yet/);
  await app.findDecisions({ topic: 'payment retries', issueKey: 'PAY-3' });
  const [listed] = await call('list', { issueKey: 'PAY-1' });
  assert.equal(listed.usage.issues, 2);
  assert.equal(listed.ladder.suggested, true);
  const team = await call('promoteScope', { id: d.id });
  assert.equal(team.scope, 'team');

  // Org needs use outside the project (or a second person); with owners set, only owners may widen reach.
  await app.adminHandler.savePolicy({ payload: { owners: ['u-lead'] } });
  await assert.rejects(call('promoteScope', { id: d.id }, 'u-bob'), /decision owner/);
  const org = await call('promoteScope', { id: d.id }, 'u-lead');
  assert.equal(org.scope, 'org');
});

test('agents only get decisions in scope; other teams do not see an issue decision', async () => {
  const d = await call('add', cap);
  await call('promote', { id: d.id });
  assert.match(await app.findDecisions({ topic: 'payment retries', issueKey: 'SHOP-1' }), /No confirmed team decisions/);
  assert.match(await app.findDecisions({ topic: 'payment retries', issueKey: 'PAY-1' }), /ISSUE DECISION — applies only to PAY-1/);
});

test('replacing a decision inherits its reach and tells the work that relied on it', async () => {
  const d = await call('add', cap);
  await call('promote', { id: d.id });
  await call('relyOn', { id: d.id, issueKey: 'PAY-2' });
  await call('relyOn', { id: d.id, issueKey: 'PAY-3' });
  await call('promoteScope', { id: d.id });
  site.issues['PAY-1'].comments.push('Because of the new PSP limits, we agreed to raise payment retries to 5 attempts.');
  const next = await call('add', { issueKey: 'PAY-1', statement: 'Payment retries are raised to 5.', quote: 'we agreed to raise payment retries to 5 attempts.', replaces: d.id });
  assert.equal(next.conflictsWith, d.id);
  const promoted = await call('promote', { id: next.id, supersede: d.id, reason: 'New PSP contract' });
  assert.equal(promoted.flagged, 2);
  assert.equal(promoted.scope, 'team');
  assert.match(site.issues['PAY-2'].comments.at(-1), /replaced by D-2/);
  assert.equal(site.props['PAY-3'].recheck, 'yes');
  const rc = await call('rechecks', { issueKey: 'PAY-2' });
  assert.equal(rc.open, true);
  const log = await call('log', { projectKey: 'PAY' });
  assert.deepEqual(log.recheck.map((i) => i.key).sort(), ['PAY-2', 'PAY-3']);
  assert.deepEqual(log.history.map((x) => x.id), [d.id]);
  assert.match(await app.findDecisions({ topic: 'payment retries', issueKey: 'PAY-2' }), /D-2[\s\S]*Replaces: D-1 \(New PSP contract\)[\s\S]*TEAM DECISION/);
});

test('changed Confluence evidence marks the decision for review and flags dependent work', async () => {
  const d = await call('add', { ...cap, sourceUrl: 'https://x.atlassian.net/wiki/spaces/ENG/pages/77/Payments' });
  assert.equal(d.sourcePageId, '77');
  await call('promote', { id: d.id });
  await call('relyOn', { id: d.id, issueKey: 'PAY-2' });
  site.pages[77].html = '<p>Retries are under discussion again.</p>';
  await app.onPageUpdated({ content: { id: '77' } });
  const [after] = await call('list', { issueKey: 'PAY-1' });
  assert.equal(after.status, 'stale');
  assert.match(site.issues['PAY-2'].comments.at(-1), /no longer matches its source/);
  assert.match(await app.findDecisions({ topic: 'payment retries', issueKey: 'PAY-1' }), /NEEDS REVIEW/);
});

test('agents can only propose; read-source tells them how to quote', async () => {
  const msg = await app.proposeDecision({ issueKey: 'PAY-1', statement: 'Retries capped at 3', quote: cap.quote });
  assert.match(msg, /NOT a team decision yet/);
  const [c] = await call('list', { issueKey: 'PAY-1' });
  assert.equal(c.origin, 'ai');
  assert.equal(c.status, 'candidate');
  assert.match(await app.readSource({ issueKey: 'PAY-1' }), /pass issueKey: PAY-1/);
});

test('guided demo walks promote -> use -> team -> replace', async () => {
  const s = await call('demoStart', { projectKey: 'DEMO' });
  assert.equal((await call('demoState', { projectKey: 'DEMO' })).step, 'promote');
  await call('promote', { id: s.capId });
  assert.equal((await call('demoState', { projectKey: 'DEMO' })).step, 'use');
  await call('demoUse', { projectKey: 'DEMO' });
  assert.equal((await call('demoState', { projectKey: 'DEMO' })).step, 'team');
  await call('promoteScope', { id: s.capId });
  const ch = await call('demoChange', { projectKey: 'DEMO' });
  const [fresh] = await call('list', { issueKey: s.issues.retry });
  assert.equal(fresh.id, ch.changeId);
  assert.equal(fresh.conflictsWith, s.capId);
  assert.equal((await call('demoState', { projectKey: 'DEMO' })).step, 'done');
});
