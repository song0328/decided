import * as resolverModule from '@forge/resolver';
import { asApp, asUser, route } from '@forge/api';

// "type": "module" bundles these CommonJS packages without __esModule interop, so take the class explicitly.
const Resolver = resolverModule.default?.default || resolverModule.default;
const api = { asApp, asUser };
import { kvs } from '@forge/kvs';
import {
  STATUS, ORIGIN, CURRENT, toPlainText, adfToText, quoteFound, confluencePageId,
  rank, formatForAgent, newId, seqId,
  relatedDecisions, history, reliantIssues, recheckComment,
} from './core.js';

const store = () => kvs.entity('decision');
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
  const conflicts = await findConflicts(draft, replaces);
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
  const current = await currentDecisions();
  const named = String(replaces || '').split(',').map((x) => x.trim()).filter((id) => current.some((d) => d.id === id));
  if (named.length) return { ids: named, how: 'agent' };
  const related = relatedDecisions(candidate, current);
  return related.length ? { ids: related.map((d) => d.id), how: 'related' } : { ids: [], how: '' };
}

// ---------- reliance — which work leaned on which decision ----------

async function recordReliance(decisionIds, issueKey, client) {
  if (!issueKey) return;
  const at = Date.now();
  await Promise.all(decisionIds.map((decisionId) =>
    reliance().set(`${decisionId}:${issueKey}:${at}`, { decisionId, issueKey, client: client || 'agent', at })));
}

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

resolver.define('list', async ({ payload }) => {
  const items = await all('by-issue', [payload.issueKey]);
  return items.sort((a, b) => b.createdAt - a.createdAt);
});

resolver.define('add', async ({ payload, context }) =>
  createCandidate({ ...payload, origin: ORIGIN.HUMAN, accountId: context.accountId }));

resolver.define('promote', async ({ payload, context }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
  if (!d.quoteVerified) throw new Error('The quote was not found in the source. Fix the quote before promoting.');
  const old = payload.supersede ? await store().get(payload.supersede) : null;
  const reason = payload.reason || '';
  const promoted = await save({
    ...d,
    status: STATUS.PROMOTED,
    promotedAt: Date.now(),
    promotedBy: context.accountId,
    promotedByName: await userName(context.accountId),
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
resolver.define('rechecks', async ({ payload }) => {
  const rs = await allOf(reliance(), 'by-issue', [payload.issueKey]);
  const ids = [...new Set(rs.map((r) => r.decisionId))];
  const ds = (await Promise.all(ids.map((id) => store().get(id)))).filter(Boolean);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${payload.issueKey}/properties/decided-recheck`);
  const flag = res.ok ? (await res.json()).value : null;
  return {
    open: flag?.recheck === 'yes',
    relied: ds.map((d) => ({ id: d.id, title: d.title, status: d.status, supersededBy: d.supersededBy })),
  };
});

resolver.define('markRechecked', async ({ payload }) => {
  await api.asApp().requestJira(route`/rest/api/3/issue/${payload.issueKey}/properties/decided-recheck`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recheck: 'no', at: Date.now() }),
  });
  return true;
});

/** Current team decisions (any issue), for "this work relies on …" from another issue's panel. */
resolver.define('current', async () => {
  const ds = await currentDecisions();
  return ds.sort((a, b) => (b.promotedAt || 0) - (a.promotedAt || 0)).map((d) => ({ id: d.id, title: d.title, issueKey: d.issueKey }));
});

/** A person marks "this work relies on that decision" from the panel (agents do it via MCP). */
resolver.define('relyOn', async ({ payload }) => {
  await recordReliance([payload.id], payload.issueKey, 'person');
  return true;
});

resolver.define('discard', async ({ payload }) => {
  const d = await store().get(payload.id);
  if (!d) throw new Error('Not found');
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

export const handler = resolver.getDefinitions();

// ---------- Rovo MCP tools (actions) ----------

async function confirmedDecisions() {
  const [promoted, stale] = await Promise.all([all('by-status', [STATUS.PROMOTED]), all('by-status', [STATUS.STALE])]);
  return [...promoted, ...stale];
}

/** MCP tool: what has the team already decided about <topic>? Only human-promoted decisions are returned. */
export async function findDecisions(payload) {
  const query = [payload?.topic, payload?.issueKey].filter(Boolean).join(' ');
  const hits = rank(await confirmedDecisions(), query, Number(payload?.limit) || 5);
  // A decision's own issue doesn't "rely" on it (agents look it up there when checking for conflicts).
  await recordReliance(hits.filter((d) => d.issueKey !== payload?.issueKey).map((d) => d.id), payload?.issueKey, 'mcp');
  if (!hits.length) {
    return `No confirmed team decisions match "${query}". Nothing has been decided about this yet — ask the team before assuming.`;
  }
  return [
    `${hits.length} confirmed team decision(s). Follow them; if your change would contradict one, stop and ask.`,
    '',
    ...hits.map(formatForAgent),
  ].join('\n\n');
}

/** MCP tool: an agent proposes a decision. It becomes a CANDIDATE — a human must promote it in Jira. */
export async function proposeDecision(payload, ctx) {
  const d = await createCandidate({
    issueKey: payload.issueKey,
    sourceUrl: payload.sourceUrl,
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
export async function readSource(payload) {
  const src = await sourceText({ issueKey: payload?.issueKey, sourceUrl: payload?.sourceUrl }, api.asUser());
  return [
    `SOURCE (${src.kind}): ${src.title}`,
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
