import * as resolverModule from '@forge/resolver';
import { asApp, asUser, route } from '@forge/api';

// "type": "module" bundles these CommonJS packages without __esModule interop, so take the class explicitly.
const Resolver = resolverModule.default?.default || resolverModule.default;
const api = { asApp, asUser };
import { kvs } from '@forge/kvs';
import {
  STATUS, ORIGIN, CURRENT, toPlainText, adfToText, quoteFound, confluencePageId,
  rank, formatForAgent, newId, seqId,
  relatedDecisions, history, reliantIssues, recheckComment, DEMO, demoStep, isSelfPromotion, projectLog, sameProject,
  SCOPE, scopeOf, usage, promotionChecks, inScopeFor, DEFAULT_POLICY, cleanPolicy,
  normalizeIssueKey, projectOf, replacementCheck, strongMatch,
} from './core.js';

const store = () => kvs.entity('decision');
const POLICY_KEY = 'policy';
async function policy() {
  return cleanPolicy((await kvs.get(POLICY_KEY)) || DEFAULT_POLICY);
}
const reliance = () => kvs.entity('reliance');

// ---------- sources: where evidence quotes live ----------

async function confluencePageText(pageId, as = api.asApp()) {
  const res = await as.requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`);
  if (!res.ok) throw new Error(`Confluence page ${pageId}: HTTP ${res.status}`);
  const page = await res.json();
  return { title: page.title, text: toPlainText(page.body?.storage?.value || '') };
}

async function issueText(issueKey, as = api.asApp()) {
  const [issueRes, commentRes] = await Promise.all([
    as.requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description`),
    as.requestJira(route`/rest/api/3/issue/${issueKey}/comment?maxResults=100`),
  ]);
  if (!issueRes.ok) throw new Error(`Jira issue ${issueKey}: HTTP ${issueRes.status}`);
  const issue = await issueRes.json();
  const comments = commentRes.ok ? (await commentRes.json()).comments || [] : [];
  const parts = [
    issue.fields?.summary || '',
    adfToText(issue.fields?.description),
    ...comments.map((c) => `${c.author?.displayName || 'someone'}: ${adfToText(c.body)}`),
  ];
  return { title: issue.fields?.summary || issueKey, text: parts.join('\n') };
}

/** Text of the place a quote should come from: a Confluence page if given, else the Jira issue itself. */
async function sourceText({ sourceUrl, issueKey }, as) {
  const pageId = confluencePageId(sourceUrl);
  if (pageId) return { kind: 'confluence', pageId, ...(await confluencePageText(pageId, as)) };
  if (issueKey) return { kind: 'jira', pageId: '', ...(await issueText(issueKey, as)) };
  throw new Error('No source: give a Confluence page URL or open the panel on a Jira issue.');
}

// ---------- storage ----------

/** Entity string values must be non-empty, so blank fields are left out (readers treat missing as ''). */
async function save(d) {
  const clean = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  await store().set(d.id, clean);
  return d;
}

const all = (index, partition) => allOf(store(), index, partition);

async function allOf(entity, index, partition) {
  const out = [];
  let cursor;
  do {
    let q = entity.query().index(index, { partition }).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    out.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor && out.length < 1000);
  return out;
}

async function userName(accountId) {
  if (!accountId) return '';
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`);
    return res.ok ? (await res.json()).displayName || '' : '';
  } catch {
    return '';
  }
}

/** Next short id (D-1, D-2, …). KVS has no atomic counter, so skip any id that is already taken. */
async function nextId() {
  let n = Number((await kvs.get('decision-seq')) || 0);
  for (let i = 0; i < 20; i += 1) {
    n += 1;
    if (!(await store().get(seqId(n)))) {
      await kvs.set('decision-seq', n);
      return seqId(n);
    }
  }
  return newId();
}

async function createCandidate({ issueKey, sourceUrl, quote, title, statement, rationale, origin, accountId, replaces }) {
  if (!quote || !statement) throw new Error('A decision needs a statement and an evidence quote.');
  const src = await sourceText({ sourceUrl, issueKey });
  const now = Date.now();
  const draft = { id: await nextId(), title: (title || statement).slice(0, 80), statement };
  const conflicts = await findConflicts({ ...draft, issueKey }, replaces);
  return save({
    id: draft.id,
    issueKey: issueKey || '',
    sourcePageId: src.pageId || '',
    sourceUrl: sourceUrl || '',
    sourceTitle: src.title || '',
    title: (title || statement).slice(0, 80),
    statement,
    rationale: rationale || '',
    quote,
    quoteVerified: quoteFound(quote, src.text),
    origin,
    status: STATUS.CANDIDATE,
    proposedBy: accountId || '',
    createdAt: now,
    promotedAt: 0,
    promotedBy: '',
    promotedByName: '',
    staleSince: 0,
    conflictsWith: conflicts.ids.join(','),
    conflictCheck: conflicts.how,
    supersedes: '',
    supersededBy: '',
    supersedeReason: '',
  });
}

// ---------- conflicts with current decisions ----------

async function currentDecisions() {
  const lists = await Promise.all(CURRENT.map((s) => all('by-status', [s])));
  return lists.flat();
}

/**
 * The app runs no LLM of its own (Forge LLM has no free allowance). The proposing agent (Rovo or Claude)
 * may name the decision it replaces; otherwise a cheap topic match flags "same topic" for a person to judge.
 */
async function findConflicts(candidate, replaces) {
  const current = sameProject(await currentDecisions(), candidate.issueKey);
  const named = String(replaces || '').split(',').map((x) => x.trim()).filter((id) => current.some((d) => d.id === id));
  if (named.length) return { ids: named, how: 'agent' };
  const related = relatedDecisions(candidate, current);
  return related.length ? { ids: related.map((d) => d.id), how: 'related' } : { ids: [], how: '' };
}

// ---------- reliance — which work leaned on which decision ----------

/**
 * Record that work on `rawIssueKey` relied on these decisions. `by` is who recorded it (their own use doesn't count
 * as evidence when they promote). Best effort: a bad key or a storage error never breaks the lookup that called it.
 */
async function recordReliance(decisionIds, rawIssueKey, client, by) {
  const issueKey = normalizeIssueKey(rawIssueKey);
  if (!issueKey || !decisionIds.length) return;
  const at = Date.now();
  await Promise.all(decisionIds.map(async (decisionId) => {
    try {
      const row = { decisionId, issueKey, client: client || 'agent', at };
      if (by) row.by = by;
      await reliance().set(`${decisionId}:${issueKey}:${at}`, row);
    } catch {
      // ignore: evidence is a nice-to-have, the answer to the agent is not
    }
  }));
}

/** The issue/project the panel is on comes from Forge's context, not from what the browser sends. */
const issueOf = (context, payload) => normalizeIssueKey(context?.extension?.issue?.key || payload?.issueKey);
const projectOfContext = (context, payload) => context?.extension?.project?.key || payload?.projectKey || projectOf(issueOf(context, payload));

const adf = (text) => ({
  type: 'doc', version: 1,
  content: text.split('\n').map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
});

/** A decision changed (superseded or stale): flag every issue whose work relied on it. */
async function notifyReliant(oldD, newD, reason) {
  const rs = reliantIssues(await allOf(reliance(), 'by-decision', [oldD.id]), oldD.issueKey);
  for (const r of rs) {
    await api.asApp().requestJira(route`/rest/api/3/issue/${r.issueKey}/comment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: adf(recheckComment(oldD, newD, reason)) }),
    });
    await api.asApp().requestJira(route`/rest/api/3/issue/${r.issueKey}/properties/decided-recheck`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recheck: 'yes', decisionId: oldD.id, replacedBy: newD?.id || '', at: Date.now() }),
    });
  }
  return rs.length;
}

// ---------- Jira issue panel resolvers ----------

const resolver = new Resolver();

/** Display names are looked up when shown, never stored (no personal data cached beyond account ids). */
async function withNames(items) {
  const ids = [...new Set(items.flatMap((d) => [d.promotedBy, d.proposedBy]).filter(Boolean))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, await userName(id)])));
  return items.map((d) => ({ ...d, promotedByName: names.get(d.promotedBy) || '', proposedByName: names.get(d.proposedBy) || '' }));
}

resolver.define('list', async ({ payload, context }) => {
  const issueKey = issueOf(context, payload);
  const items = await all('by-issue', [issueKey]);
  // Show only conflicts that still matter: current decisions in the same project (older data may name others).
  const live = new Set(sameProject(await currentDecisions(), issueKey).map((d) => d.id));
  const cleaned = items.map((d) => ({ ...d, conflictsWith: (d.conflictsWith || '').split(',').filter((id) => live.has(id)).join(',') }));
  const pol = await policy();
  const withLadder = await Promise.all(cleaned.map(async (d) => {
    if (d.status !== STATUS.PROMOTED) return d;
    const use = usage(d, await allOf(reliance(), 'by-decision', [d.id]));
    return { ...d, scope: scopeOf(d), usage: use, ladder: promotionChecks(d, use, context.accountId, pol) };
  }));
  return withNames(withLadder.sort((a, b) => (b.createdAt - a.createdAt) || (Number(String(b.id).slice(2)) - Number(String(a.id).slice(2)))));
});

/** Move a current decision one rung up the ladder (issue -> team -> org) if its checks pass. */
resolver.define('promoteScope', async ({ payload, context }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
  const use = usage(d, await allOf(reliance(), 'by-decision', [d.id]));
  const ladder = promotionChecks(d, use, context.accountId, await policy());
  if (!ladder.target) throw new Error(`${d.id} cannot be promoted further.`);
  if (!ladder.allowed) {
    const missing = ladder.checks.filter((c) => !c.ok).map((c) => c.label).join('; ');
    throw new Error(`${d.id} cannot become a ${ladder.target} decision yet. Missing: ${missing}.`);
  }
  return save({ ...d, scope: ladder.target, scopeBy: context.accountId, scopeAt: Date.now() });
});

resolver.define('add', async ({ payload, context }) =>
  createCandidate({ ...payload, origin: ORIGIN.HUMAN, accountId: context.accountId }));

resolver.define('promote', async ({ payload, context }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
  if (d.status !== STATUS.CANDIDATE) throw new Error(`${d.id} is not a candidate any more.`);
  if (!d.quoteVerified) throw new Error('The quote was not found in the source. Fix the quote before promoting.');
  const old = payload.supersede ? await store().get(payload.supersede) : null;
  if (payload.supersede) {
    const check = replacementCheck(d, old, context.accountId, await policy());
    if (!check.ok) throw new Error(check.reason);
  }
  const reason = payload.reason || '';
  const promoted = await save({
    ...d,
    status: STATUS.PROMOTED,
    promotedAt: Date.now(),
    promotedBy: context.accountId,
    promotedByName: '',
    selfPromoted: isSelfPromotion(d, context.accountId),
    scope: old ? scopeOf(old) : SCOPE.ISSUE,
    scopeBy: context.accountId,
    scopeAt: Date.now(),
    staleSince: 0,
    supersedes: old ? old.id : '',
    supersedeReason: old ? reason : '',
    conflictsWith: old ? (d.conflictsWith || '').split(',').filter((x) => x && x !== old.id).join(',') : d.conflictsWith,
  });
  let flagged = 0;
  if (old) {
    await save({ ...old, status: STATUS.SUPERSEDED, supersededBy: d.id, supersedeReason: reason });
    flagged = await notifyReliant(old, promoted, reason);
  }
  return { ...promoted, flagged };
});

/** Oldest -> newest versions of a decision. */
resolver.define('history', async ({ payload }) => {
  const seed = await store().get(payload.id);
  if (!seed) return [];
  const byId = new Map([[seed.id, seed]]);
  for (let i = 0; i < 20; i += 1) {
    const next = [...byId.values()].flatMap((x) => [x.supersedes, x.supersededBy]).filter((id) => id && !byId.has(id));
    if (!next.length) break;
    for (const id of next) {
      const v = await store().get(id);
      byId.set(id, v || { id });
    }
  }
  return history(seed.id, byId);
});

/** For the banner: decisions this issue's work relied on, and whether one changed since. */
resolver.define('rechecks', async ({ payload, context }) => {
  const issueKey = issueOf(context, payload);
  const rs = await allOf(reliance(), 'by-issue', [issueKey]);
  const ids = [...new Set(rs.map((r) => r.decisionId))];
  const ds = (await Promise.all(ids.map((id) => store().get(id)))).filter(Boolean);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/properties/decided-recheck`);
  const flag = res.ok ? (await res.json()).value : null;
  return {
    open: flag?.recheck === 'yes',
    relied: ds.map((d) => ({ id: d.id, title: d.title, status: d.status, supersededBy: d.supersededBy })),
  };
});

resolver.define('markRechecked', async ({ payload, context }) => {
  await api.asApp().requestJira(route`/rest/api/3/issue/${issueOf(context, payload)}/properties/decided-recheck`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recheck: 'no', at: Date.now() }),
  });
  return true;
});

/** Current team decisions (any issue), for "this work relies on …" from another issue's panel. */
resolver.define('current', async ({ payload, context }) => {
  const issueKey = issueOf(context, payload);
  const here = projectOf(issueKey);
  const ds = (await currentDecisions()).filter((d) => projectOf(d.issueKey) === here || scopeOf(d) !== SCOPE.ISSUE);
  return ds.sort((a, b) => (b.promotedAt || 0) - (a.promotedAt || 0))
    .map((d) => ({ id: d.id, title: d.title, issueKey: d.issueKey, project: projectOf(d.issueKey), scope: scopeOf(d) }));
});

/** A person marks "this work relies on that decision" from the panel (agents do it via MCP). */
resolver.define('relyOn', async ({ payload, context }) => {
  const issueKey = issueOf(context, payload);
  const d = await store().get(payload.id);
  if (!d || !CURRENT.includes(d.status)) throw new Error('That decision is not current.');
  if (projectOf(d.issueKey) !== projectOf(issueKey) && scopeOf(d) === SCOPE.ISSUE) throw new Error(`${d.id} is another project's issue decision.`);
  await recordReliance([d.id], issueKey, 'person', context.accountId);
  return true;
});

resolver.define('discard', async ({ payload }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
  if (d.status !== STATUS.CANDIDATE && d.status !== STATUS.STALE) {
    throw new Error(`${d.id} is a current decision. Replace it with a new one instead, so the work that relied on it is told.`);
  }
  return save({ ...d, status: STATUS.DISCARDED });
});

/** Re-check a quote against the current source (used by "Re-check" on stale items). */
resolver.define('recheck', async ({ payload }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
  const src = await sourceText(d);
  const ok = quoteFound(d.quote, src.text);
  const status = d.status === STATUS.STALE && ok ? STATUS.PROMOTED : d.status;
  return save({ ...d, quoteVerified: ok, status, staleSince: ok ? 0 : d.staleSince });
});

// ---------- Decision log (Jira project page) ----------

/** Every decision in this project, grouped, plus the issues still waiting for a re-check (JQL on our property). */
resolver.define('log', async ({ payload, context }) => {
  const projectKey = projectOfContext(context, payload);
  if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey)) throw new Error('Open the Decision log from a Jira project.');
  const statuses = [STATUS.PROMOTED, STATUS.STALE, STATUS.CANDIDATE, STATUS.SUPERSEDED];
  const lists = await Promise.all(statuses.map((s) => all('by-status', [s])));
  const log = projectLog(await withNames(lists.flat()), projectKey);
  let recheck = [];
  try {
    const jql = `project = "${projectKey}" AND decidedRecheck = yes ORDER BY updated DESC`;
    const res = await api.asUser().requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=50`);
    if (res.ok) recheck = ((await res.json()).issues || []).map((i) => ({ key: i.key, summary: i.fields?.summary || '' }));
  } catch {
    recheck = [];
  }
  const org = lists[0].filter((d) => scopeOf(d) === SCOPE.ORG);
  return { ...log, org: await withNames(org), recheck };
});

// ---------- guided demo (one click for judges, works without Rovo) ----------

const demoKey = (projectKey) => `demo-${projectKey}`;

async function asUserJson(method, path, body) {
  const res = await api.asUser().requestJira(path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function demoIssueTypeId(projectKey) {
  const res = await asUserJson('GET', route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`);
  const types = res.issueTypes || res.values || [];
  const standard = types.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
  const pick = standard.find((t) => t.name === 'Task') || standard[0];
  if (!pick) throw new Error(`No issue type in ${projectKey} that Decided can use for the demo.`);
  return pick.id;
}

resolver.define('demoState', async ({ payload, context }) => {
  const state = await kvs.get(demoKey(projectOfContext(context, payload)));
  const decisions = state?.issues?.retry ? await all('by-issue', [state.issues.retry]) : [];
  return { state: state || null, step: demoStep(state, decisions) };
});

/** Step 1: create the fictional issues in this project (as the user) and three candidates to promote. */
resolver.define('demoStart', async ({ payload, context }) => {
  const projectKey = projectOfContext(context, payload);
  // Saved after every step, so pressing the button again after a failure continues instead of duplicating issues.
  const state = (await kvs.get(demoKey(projectKey))) || { issues: {}, comments: {}, ids: {} };
  if (state.capId) return state;
  state.issues ||= {}; state.comments ||= {}; state.ids ||= {};
  const saveState = () => kvs.set(demoKey(projectKey), state);
  let typeId;
  for (const i of DEMO.issues) {
    if (!state.issues[i.ref]) {
      typeId ||= await demoIssueTypeId(projectKey);
      const created = await asUserJson('POST', route`/rest/api/3/issue`, {
        fields: { project: { key: projectKey }, issuetype: { id: typeId }, summary: i.summary, description: adf(i.description) },
      });
      state.issues[i.ref] = created.key;
      await saveState();
    }
    for (let n = state.comments[i.ref] || 0; n < i.comments.length; n += 1) {
      await asUserJson('POST', route`/rest/api/3/issue/${state.issues[i.ref]}/comment`, { body: adf(i.comments[n]) });
      state.comments[i.ref] = n + 1;
      await saveState();
    }
  }
  // These stand in for what the Decided agent proposes in Rovo, so they are AI proposals: promoting one is a
  // person reviewing an agent's suggestion, not someone approving their own text.
  for (const c of DEMO.candidates) {
    if (state.ids[c.key]) continue;
    const d = await createCandidate({ issueKey: state.issues.retry, quote: c.quote, title: c.title, statement: c.statement, origin: ORIGIN.AI });
    state.ids[c.key] = d.id;
    await saveState();
  }
  state.capId = state.ids.cap;
  state.at = Date.now();
  await saveState();
  return state;
});

/** Step 2: the charge client (via a coding agent over MCP) and the checkout work start relying on the issue decision. */
resolver.define('demoUse', async ({ payload, context }) => {
  const state = await kvs.get(demoKey(projectOfContext(context, payload)));
  if (!state?.issues) throw new Error('Run the demo first.');
  await recordReliance([state.capId], state.issues['charge-client'], 'mcp');
  await recordReliance([state.capId], state.issues['checkout-msg'], 'person');
  const next = { ...state, used: true };
  await kvs.set(demoKey(projectOfContext(context, payload)), next);
  return next;
});

/**
 * Step 4: a later meeting changes the (now team-wide) rule — a new candidate that replaces it, so the work that
 * relied on it is asked to re-check.
 */
resolver.define('demoChange', async ({ payload, context }) => {
  const state = await kvs.get(demoKey(projectOfContext(context, payload)));
  if (!state?.issues) throw new Error('Run the demo first.');
  const cap = await store().get(state.capId);
  if (!cap || cap.status !== STATUS.PROMOTED) throw new Error(`Promote ${state.capId} first.`);
  await asUserJson('POST', route`/rest/api/3/issue/${state.issues.retry}/comment`, { body: adf(DEMO.change.comment) });
  const c = DEMO.change;
  const d = await createCandidate({
    issueKey: state.issues.retry, quote: c.quote, title: c.title, statement: c.statement, rationale: c.rationale,
    origin: ORIGIN.AI, replaces: cap.id,
  });
  const next = { ...state, changed: true, changeId: d.id };
  await kvs.set(demoKey(projectOfContext(context, payload)), next);
  return next;
});

export const handler = resolver.getDefinitions();

// ---------- Jira admin page: who may widen a decision's reach ----------
// A separate function, so only the admin page module (visible to Jira admins) can change the policy.

const admin = new Resolver();
admin.define('getPolicy', async () => policy());
admin.define('savePolicy', async ({ payload }) => {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
  const isAdmin = res.ok && Boolean((await res.json())?.permissions?.ADMINISTER?.havePermission);
  if (!isAdmin) throw new Error('Only Jira administrators can change the promotion policy.');
  const p = cleanPolicy(payload);
  await kvs.set(POLICY_KEY, p);
  return p;
});
export const adminHandler = admin.getDefinitions();

// ---------- Rovo MCP tools (actions) ----------

async function confirmedDecisions() {
  const [promoted, stale] = await Promise.all([all('by-status', [STATUS.PROMOTED]), all('by-status', [STATUS.STALE])]);
  return [...promoted, ...stale];
}

/** MCP tool: what has the team already decided about <topic>? Only human-promoted decisions are returned. */
export async function findDecisions(payload, ctx) {
  const issueKey = normalizeIssueKey(payload?.issueKey);
  const query = String(payload?.topic || '');
  // Binding decisions first; other teams' decisions only when they clearly match, and at most two, so the answer stays short.
  let others = 0;
  const ranked = rank(inScopeFor(await confirmedDecisions(), issueKey), query, 20)
    .filter((d) => d.appliesHere !== false || (strongMatch(d, query) && (others += 1) <= 2));
  const hits = await withNames(ranked.slice(0, Number(payload?.limit) || 5));
  // Only decisions that matched the topic count as used, and a decision's own issue doesn't "rely" on it
  // (agents look it up there when checking for conflicts).
  await recordReliance(hits.filter((d) => d.issueKey !== issueKey && strongMatch(d, query)).map((d) => d.id), issueKey, 'mcp',
    payload?.context?.accountId || ctx?.principal?.accountId);
  if (!hits.length) {
    return `No confirmed team decisions match "${query}". Nothing has been decided about this yet — ask the team before assuming.`;
  }
  const rules = hits.filter((d) => d.appliesHere !== false).length;
  return [
    `${hits.length} confirmed decision(s), ${rules} of them binding for ${issueKey || 'this work'}${issueKey ? '' : ' (pass issueKey to know which team rules apply)'}. Follow the binding ones; if your change would contradict one, stop and ask.`,
    '',
    ...hits.map(formatForAgent),
  ].join('\n\n');
}

/** MCP tool: an agent proposes a decision. It becomes a CANDIDATE — a human must promote it in Jira. */
export async function proposeDecision(payload, ctx) {
  const d = await createCandidate({
    issueKey: payload.issueKey,
    sourceUrl: cleanUrl(payload.sourceUrl),
    quote: payload.quote,
    title: payload.title,
    statement: payload.statement,
    rationale: payload.rationale,
    replaces: payload.replaces,
    origin: ORIGIN.AI,
    accountId: payload?.context?.accountId || ctx?.principal?.accountId,
  });
  const conflicts = (d.conflictsWith || '').split(',').filter(Boolean);
  return [
    `Saved candidate ${d.id} on ${d.issueKey || d.sourceTitle}.`,
    d.quoteVerified
      ? 'Quote verified in the source. It is NOT a team decision yet — a teammate must promote it in Jira.'
      : 'WARNING: the quote was not found verbatim in the source, so it cannot be promoted until it is corrected.',
    conflicts.length ? `Flagged as possibly replacing ${conflicts.join(', ')}; the teammate decides.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * MCP tool: the text of a Jira issue (summary, description, comments) or a Confluence page, read with the
 * caller's own permissions, so an agent can find decisions in it and quote them verbatim.
 */
/** Agents sometimes wrap URLs in backticks or quotes; keep just the URL. */
function cleanUrl(url) {
  return String(url || '').trim().replace(/^[`'"<(]+|[`'">).,]+$/g, '');
}

export async function readSource(payload) {
  const sourceUrl = cleanUrl(payload?.sourceUrl);
  const src = await sourceText({ issueKey: payload?.issueKey, sourceUrl }, api.asUser());
  return [
    `SOURCE (${src.kind}): ${src.title}`,
    src.kind === 'confluence'
      ? `When you propose a decision from this page, you MUST pass sourceUrl: ${sourceUrl} — otherwise its quote is checked against the Jira issue and fails.`
      : `When you propose a decision from this issue, pass issueKey: ${payload?.issueKey} and no sourceUrl.`,
    'Quote decisions from this text verbatim, one sentence each. Open questions, ideas and action items are not decisions.',
    '',
    src.text.slice(0, 60000),
  ].join('\n');
}

// ---------- Confluence trigger: mark decisions stale when their evidence changes ----------

export async function onPageUpdated(event) {
  const pageId = String(event?.content?.id || '');
  if (!pageId) return;
  const decisions = await all('by-page', [pageId]);
  if (!decisions.length) return;
  const { text } = await confluencePageText(pageId);
  for (const d of decisions) {
    const ok = quoteFound(d.quote, text);
    if (!ok && d.status === STATUS.PROMOTED) {
      const stale = await save({ ...d, quoteVerified: false, status: STATUS.STALE, staleSince: Date.now() });
      await notifyReliant(stale, null, '');
    }
    else if (ok !== d.quoteVerified) await save({ ...d, quoteVerified: ok });
  }
}
