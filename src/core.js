// Pure helpers — no Forge imports, so they can be unit-tested with `node --test`.

export const STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  PROMOTED: 'promoted',
  DISCARDED: 'discarded',
  STALE: 'stale', // was promoted, but its quote no longer appears in the source
  SUPERSEDED: 'superseded', // replaced by a newer promoted decision (kept as history)
});

/** Statuses an agent should see as "current team decisions". */
export const CURRENT = Object.freeze([STATUS.PROMOTED, STATUS.STALE]);

export const ORIGIN = Object.freeze({
  HUMAN: 'human', // a person wrote the candidate
  AI: 'ai', // an AI (panel suggestion or MCP agent) proposed it
});

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** Storage-format HTML or plain text → comparable plain text. */
export function toPlainText(html = '') {
  return String(html)
    .replace(/<(br|\/p|\/li|\/h\d|\/tr|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ');
}

/** Lowercase, unify quotes/dashes, collapse whitespace — so formatting changes don't break a quote. */
export function normalize(text = '') {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does the quote appear verbatim (modulo whitespace/case/typography) in the source? */
export function quoteFound(quote, sourceText) {
  const q = normalize(quote);
  if (q.length < 8) return false; // too short to count as evidence
  return normalize(sourceText).includes(q);
}

/** Atlassian Document Format (Jira comments/description) → plain text. */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join(node.type === 'doc' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem', 'blockquote'].includes(node.type) ? inner + '\n' : inner;
}

/** Extract a Confluence page id from a page URL (or accept a bare id). */
export function confluencePageId(url = '') {
  const s = String(url).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/pages\/(?:edit-v2\/)?(\d+)/) || s.match(/[?&]pageId=(\d+)/);
  return m ? m[1] : null;
}

const STOP = new Set('a an the and or of to in on for with is are be by we our it this that what which about'.split(' '));

/** Crude English stem so "retry"/"retries"/"retried" and "decline"/"declines" meet. */
export function stem(t) {
  if (t.length <= 3) return t;
  if (t.endsWith('ies') || t.endsWith('ied')) return `${t.slice(0, -3)}y`;
  if (t.endsWith('es') && /(ss|sh|ch|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
  return t;
}

export function tokens(text = '') {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Simple relevance score for MCP lookups: shared tokens, title/statement weighted. */
export function score(decision, query) {
  const q = new Set(tokens(query));
  if (!q.size) return 1; // empty query → everything matches equally
  const weigh = (text, w) => tokens(text).reduce((s, t) => s + (q.has(t) ? w : 0), 0);
  // The issue key decides scope (inScopeFor), never relevance: matching on the project key would make every
  // decision in the project look relevant to any question, and record "use" that never happened.
  return weigh(decision.title, 3) + weigh(decision.statement, 2) + weigh(decision.rationale, 1);
}

/**
 * Was this decision really what the agent asked about? Its title shares a word with the question, or at least two
 * different words match. Only such hits are recorded as "used" — one shared word like "page" is not use.
 */
export function strongMatch(decision, query) {
  const q = new Set(tokens(query));
  if (!q.size) return false;
  if (tokens(decision.title).some((t) => q.has(t))) return true;
  const hit = new Set([...tokens(decision.statement), ...tokens(decision.rationale)].filter((t) => q.has(t)));
  return hit.size >= 2;
}

export function rank(decisions, query, limit = 5) {
  return decisions
    .map((d) => { const s = score(d, query); return { d, s: s > 0 && d.appliesHere !== false ? s + 0.5 : s }; })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.d.promotedAt || 0) - (a.d.promotedAt || 0))
    .slice(0, limit)
    .map((x) => x.d);
}

/** How a decision is shown to a coding agent: short, with provenance, so it can cite it. */
export function formatForAgent(d) {
  const who = d.origin === ORIGIN.AI
    ? 'AI-proposed, human-promoted'
    : d.selfPromoted ? 'entered and promoted by the same person — not reviewed by a second person' : 'human-entered, promoted by another person';
  const when = d.promotedAt ? new Date(d.promotedAt).toISOString().slice(0, 10) : 'unknown date';
  const lines = [
    `DECISION ${d.id}: ${d.title}`,
    `  What: ${d.statement}`,
    d.rationale ? `  Why: ${d.rationale}` : null,
    `  Evidence: "${d.quote}" — ${d.sourceUrl || d.issueKey}`,
    d.supersedes ? `  Replaces: ${d.supersedes}${d.supersedeReason ? ` (${d.supersedeReason})` : ''} — the older decision is no longer valid` : null,
    d.scope || d.status ? `  ${scopeLine(d)}` : null,
    `  Status: ${d.status === STATUS.STALE ? 'NEEDS REVIEW — the quoted source text changed; do not rely on it without asking' : 'confirmed'} (${who}, ${when}${d.promotedByName ? `, by ${d.promotedByName}` : ''})`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Validate the LLM's JSON candidates; keep only those whose quote really exists in the source. */
export function verifiedSuggestions(raw, sourceText, max = 5) {
  let list;
  try {
    const json = String(raw).match(/\[[\s\S]*\]/);
    list = JSON.parse(json ? json[0] : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.quote === 'string' && typeof c.statement === 'string')
    .map((c) => ({
      title: String(c.title || c.statement).slice(0, 80),
      statement: String(c.statement).slice(0, 400),
      rationale: String(c.rationale || '').slice(0, 400),
      quote: String(c.quote).slice(0, 500),
      quoteVerified: quoteFound(c.quote, sourceText),
    }))
    .filter((c) => c.quoteVerified)
    .slice(0, max);
}

// ---------- conflicts & supersede history ----------

/** Share of the smaller token set that also appears in the other — 0..1. */
export function overlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n += 1;
  return n / Math.min(A.size, B.size);
}

/**
 * Current decisions that talk about the same thing as the new candidate (cheap pre-filter).
 * The LLM then judges which of these actually CONTRADICT it; without the LLM they are shown as "related".
 */
export function relatedDecisions(candidate, decisions, threshold = 0.34, limit = 5) {
  const text = (d) => `${d.title} ${d.statement}`;
  return decisions
    .filter((d) => d.id !== candidate.id && CURRENT.includes(d.status))
    .map((d) => ({ d, s: overlap(text(candidate), text(d)) }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.d);
}

/** Parse the LLM's contradiction verdict: JSON array of ids, filtered to ids we offered. */
export function parseConflictIds(raw, offeredIds) {
  try {
    const json = String(raw).match(/\[[\s\S]*?\]/);
    const ids = JSON.parse(json ? json[0] : raw);
    return Array.isArray(ids) ? ids.map(String).filter((id) => offeredIds.includes(id)) : [];
  } catch {
    return [];
  }
}

/** Follow supersededBy links to the decision that is current now (guards against cycles). */
export function latestInChain(id, byId) {
  let cur = byId.get(id);
  const seen = new Set();
  while (cur && cur.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.supersededBy) || cur;
    if (seen.has(cur.id)) break;
  }
  return cur;
}

/** Oldest → newest list of decisions linked by supersedes/supersededBy. */
export function history(id, byId) {
  let first = byId.get(id);
  const seen = new Set();
  while (first && first.supersedes && byId.get(first.supersedes) && !seen.has(first.id)) {
    seen.add(first.id);
    first = byId.get(first.supersedes);
  }
  const out = [];
  const seen2 = new Set();
  for (let d = first; d && !seen2.has(d.id); d = d.supersededBy ? byId.get(d.supersededBy) : null) {
    seen2.add(d.id);
    out.push(d);
  }
  return out;
}

// ---------- reliance (which work leaned on which decision) ----------

/** Issues that relied on a decision, newest reliance first, one row per issue. */
export function reliantIssues(reliances, exceptIssueKey = '') {
  const latest = new Map();
  for (const r of reliances) {
    if (!r.issueKey || r.issueKey === exceptIssueKey) continue;
    const prev = latest.get(r.issueKey);
    if (!prev || r.at > prev.at) latest.set(r.issueKey, r);
  }
  return [...latest.values()].sort((a, b) => b.at - a.at);
}

/** The Jira comment posted on work that relied on a decision that just changed. */
export function recheckComment(oldD, newD, reason) {
  const plain = (s) => String(s || '').trim().replace(/[.。]+$/, '');
  const what = newD
    ? `was replaced by ${newD.id}: "${plain(newD.statement)}"`
    : 'no longer matches its source (the quoted text changed)';
  return [
    `⚠️ Decided: this work relied on ${oldD.id} ("${plain(oldD.statement)}"), which ${what}.`,
    reason ? `Reason: ${reason}` : null,
    'Please re-check this work against the current decision.',
  ].filter(Boolean).join('\n');
}

/** Short, readable ids people can say out loud: D-1, D-2, … */
export function seqId(n) {
  return `D-${n}`;
}

export function newId(now = Date.now()) {
  return `D-${now.toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;
}

// ---------- guided demo for judges (fictional "Northwind Pay" data, created in the judge's own project) ----------

export const DEMO = Object.freeze({
  issues: [
    {
      ref: 'retry',
      summary: '[Decided demo] Improve retries on failed card payments',
      description: 'About 4% of card payments fail on the first attempt, mostly PSP timeouts. We need one retry policy that checkout, ops alerts and the charge client all follow.',
      comments: [
        'From the 3 Nov payments sync: We agreed payment retries are capped at 3 with exponential backoff. Hard declines such as insufficient funds or a stolen card are never retried.',
        'Agreed with Ops: the whole retry sequence must finish within 30 seconds so the checkout page never times out.',
        "Could we add jitter to the backoff? Let's try it in staging first; not decided yet.",
      ],
    },
    {
      ref: 'charge-client',
      summary: '[Decided demo] Fix retry logic in the charge client',
      description: "The charge client still retries twice with a fixed delay and retries every error. Bring it in line with the team's retry policy.",
      comments: [],
    },
    {
      ref: 'checkout-msg',
      summary: "[Decided demo] Checkout: show a 'still trying' message while a payment is retried",
      description: 'Copy depends on how many attempts we make.',
      comments: [],
    },
  ],
  // Candidates the demo creates on the "retry" issue. Quotes are copied verbatim from the comments above.
  candidates: [
    { key: 'cap', title: 'Payment retries capped at 3', statement: 'Payment retries are capped at 3 with exponential backoff.', quote: 'We agreed payment retries are capped at 3 with exponential backoff.' },
    { key: 'declines', title: 'Hard declines are never retried', statement: 'Hard declines (insufficient funds, stolen card) are never retried.', quote: 'Hard declines such as insufficient funds or a stolen card are never retried.' },
    { key: 'budget', title: 'Retry sequence finishes within 30 s', statement: 'The whole retry sequence finishes within 30 seconds.', quote: 'the whole retry sequence must finish within 30 seconds so the checkout page never times out.' },
  ],
  // Step 2: a later meeting changes the rule.
  change: {
    comment: 'From the 2 Dec PSP migration sync: because of the new PSP limits, we agreed to raise payment retries to 5 attempts with exponential backoff.',
    title: 'Payment retries raised to 5',
    statement: 'Payment retries are raised to 5 attempts with exponential backoff.',
    quote: 'we agreed to raise payment retries to 5 attempts with exponential backoff.',
    rationale: 'New PSP contract and rate limits from 1 Jan.',
  },
});

/** Which guided-demo step to show, from the stored demo state and the decisions on the demo issue. */
export function demoStep(state, decisions = []) {
  if (!state || !state.capId) return 'start'; // not finished setting up (a retry continues where it stopped)
  if (state.changed) return 'done';
  const cap = decisions.find((d) => d.id === state.capId);
  if (!cap || cap.status !== STATUS.PROMOTED) return 'promote';
  if (!state.used) return 'use';
  if (scopeOf(cap) === SCOPE.ISSUE) return 'team';
  return 'change';
}

// ---------- self-promotion & project decision log ----------

/** A person promoting a candidate they typed in themselves: no second pair of eyes. AI proposals don't count. */
export function isSelfPromotion(d, accountId) {
  return Boolean(accountId) && d.origin === ORIGIN.HUMAN && d.proposedBy === accountId;
}

/** Decisions whose issue belongs to the project, grouped for the Decision log page. */
export function projectLog(decisions, projectKey) {
  const mine = decisions.filter((d) => String(d.issueKey || '').startsWith(`${projectKey}-`));
  const by = (s) => mine.filter((d) => d.status === s);
  const newest = (k) => (a, b) => (b[k] || 0) - (a[k] || 0);
  return {
    current: by(STATUS.PROMOTED).sort(newest('promotedAt')),
    review: by(STATUS.STALE).sort(newest('staleSince')),
    candidates: by(STATUS.CANDIDATE).sort(newest('createdAt')),
    history: by(STATUS.SUPERSEDED).sort(newest('promotedAt')),
    selfPromoted: by(STATUS.PROMOTED).filter((d) => d.selfPromoted).length,
  };
}

/** "pay-12", "PAY-12 ", ".../browse/PAY-12" -> "PAY-12"; anything else -> "". Agents pass keys in many shapes. */
export function normalizeIssueKey(value = '') {
  const m = String(value || '').match(/(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*-\d+)(?![0-9])/);
  return m ? m[1].toUpperCase() : '';
}

/** Jira project key of an issue key ("PAY-12" -> "PAY"). Decisions are a team's, so conflicts stay inside one project. */
export function projectOf(issueKey = '') {
  const m = String(issueKey).match(/^([A-Z][A-Z0-9_]*)-\d+$/);
  return m ? m[1] : '';
}

export function sameProject(decisions, issueKey) {
  const p = projectOf(issueKey);
  return p ? decisions.filter((d) => projectOf(d.issueKey) === p) : decisions;
}

// ---------- promotion ladder: candidate → issue decision → team decision → org standard ----------
// Promotion is not "approve"; it widens WHO the decision applies to (which work, which agents),
// and each step needs more evidence than the one before.

export const SCOPE = Object.freeze({ ISSUE: 'issue', TEAM: 'team', ORG: 'org' });
export const SCOPE_ORDER = [SCOPE.ISSUE, SCOPE.TEAM, SCOPE.ORG];
export const SCOPE_LABEL = { issue: 'Issue decision', team: 'Team decision', org: 'Org standard' };

/** Decisions promoted before the ladder existed applied project-wide, so treat them as team decisions. */
export function scopeOf(d) {
  return SCOPE_ORDER.includes(d.scope) ? d.scope : SCOPE.TEAM;
}

export function nextScope(d) {
  const i = SCOPE_ORDER.indexOf(scopeOf(d));
  return i >= 0 && i < SCOPE_ORDER.length - 1 ? SCOPE_ORDER[i + 1] : null;
}

/**
 * Where a decision has actually been used: distinct issues and projects other than its own.
 * Use recorded by the person who last promoted it doesn't count — one person can't vouch for themselves.
 */
export function usage(d, reliances = []) {
  const own = projectOf(d.issueKey);
  const promoter = d.scopeBy || d.promotedBy;
  const issues = new Set();
  const otherProjects = new Set();
  for (const r of reliances) {
    if (!r.issueKey || r.issueKey === d.issueKey) continue;
    if (r.by && promoter && r.by === promoter) continue;
    issues.add(r.issueKey);
    const p = projectOf(r.issueKey);
    if (p && p !== own) otherProjects.add(p);
  }
  return { issues: issues.size, otherProjects: [...otherProjects] };
}

/**
 * Checks for promoting a CURRENT decision one rung up. Like CI checks on a pull request:
 * the quote must still be in the source, and there must be evidence beyond one person's click.
 */
export function promotionChecks(d, use, accountId, policy = {}) {
  const target = nextScope(d);
  if (!target || d.status !== STATUS.PROMOTED) return { target: null, checks: [], allowed: false, suggested: false };
  const owners = Array.isArray(policy.owners) ? policy.owners.filter(Boolean) : [];
  const lastBy = d.scopeBy || d.promotedBy;
  const quote = { key: 'quote', label: 'Evidence quote still in the source', ok: Boolean(d.quoteVerified) };
  const second = { key: 'second', label: 'Promoted by someone other than the last promoter', ok: Boolean(accountId) && accountId !== lastBy };
  let evidence;
  if (target === SCOPE.TEAM) {
    evidence = { key: 'used', label: `Used by other work in the project (${use.issues}/2 issues)`, ok: use.issues >= 2 };
  } else {
    evidence = { key: 'used', label: `Used outside its own project (${use.otherProjects.length ? use.otherProjects.join(', ') : 'none yet'})`, ok: use.otherProjects.length >= 1 };
  }
  const checks = [quote, evidence, second];
  let allowed = quote.ok && (policy.requireSecondPerson ? second.ok : second.ok || evidence.ok);
  if (owners.length) {
    const owner = { key: 'owner', label: 'Promoted by a decision owner (set by your Jira admin)', ok: owners.includes(accountId) };
    checks.push(owner);
    allowed = allowed && owner.ok;
  }
  if (policy.requireSecondPerson) second.label += ' (required by your Jira admin)';
  const rule = [
    policy.requireSecondPerson ? 'Needs the quote and a second person.' : 'Needs the quote, plus real use by others or a second person.',
    owners.length ? 'Only decision owners can widen its reach.' : '',
  ].filter(Boolean).join(' ');
  return { target, checks, allowed, suggested: quote.ok && evidence.ok, rule };
}

export const DEFAULT_POLICY = Object.freeze({ owners: [], requireSecondPerson: false });

/**
 * "Promote, replacing D-x": the candidate inherits D-x's reach, so widening rules apply to it too.
 * Returns { ok, reason }.
 */
export function replacementCheck(candidate, old, accountId, policy = {}) {
  if (!old || !CURRENT.includes(old.status)) return { ok: false, reason: 'The decision it replaces is no longer current.' };
  if (old.id === candidate.id) return { ok: false, reason: 'A decision cannot replace itself.' };
  if (!String(candidate.conflictsWith || '').split(',').includes(old.id)) return { ok: false, reason: `${candidate.id} is not flagged as replacing ${old.id}.` };
  if (projectOf(old.issueKey) !== projectOf(candidate.issueKey)) return { ok: false, reason: 'Only a decision in the same project can be replaced.' };
  if (scopeOf(old) === SCOPE.ISSUE) return { ok: true, reason: '' };
  const owners = Array.isArray(policy.owners) ? policy.owners.filter(Boolean) : [];
  const reach = SCOPE_LABEL[scopeOf(old)];
  if (owners.length && !owners.includes(accountId)) return { ok: false, reason: `Replacing a ${reach} needs a decision owner (set by your Jira admin).` };
  if (isSelfPromotion(candidate, accountId)) {
    return { ok: false, reason: `You entered ${candidate.id} yourself, so replacing a ${reach} needs a second person to promote it. Or promote it, keeping both, as an Issue decision.` };
  }
  if (policy.requireSecondPerson && accountId && accountId === (old.scopeBy || old.promotedBy)) {
    return { ok: false, reason: `Your Jira admin requires a second person: someone other than whoever made ${old.id} a ${reach} must approve the replacement.` };
  }
  return { ok: true, reason: '' };
}

/** Admin settings are stored as given by the UI; keep only what the ladder understands. */
export function cleanPolicy(p = {}) {
  const owners = (Array.isArray(p.owners) ? p.owners : [p.owners])
    .map((o) => (typeof o === 'string' ? o : o && (o.id || o.accountId)))
    .filter((o) => typeof o === 'string' && o.length > 0 && o.length < 200);
  return { owners: [...new Set(owners)].slice(0, 50), requireSecondPerson: Boolean(p.requireSecondPerson) };
}

/** Which current decisions an agent working on `issueKey` must follow. */
export function inScopeFor(decisions, rawIssueKey) {
  const issueKey = normalizeIssueKey(rawIssueKey);
  const p = projectOf(issueKey);
  const out = [];
  for (const d of decisions) {
    const s = scopeOf(d);
    if (s === SCOPE.ORG) out.push({ ...d, appliesHere: true });
    // Without an issue we can't tell whose rules apply: team decisions are shown with their project, not as rules.
    else if (!issueKey) { if (s === SCOPE.TEAM) out.push({ ...d, appliesHere: false }); }
    // Another team's decision: visible (following it is evidence it deserves Org reach), but not a rule here.
    else if (s === SCOPE.TEAM) out.push({ ...d, appliesHere: projectOf(d.issueKey) === p });
    else if (d.issueKey === issueKey) out.push({ ...d, appliesHere: true });
    // Another issue's decision in the same project: shown, but clearly not a rule here yet.
    // If the agent follows it, that use is recorded as evidence that it may deserve Team reach.
    else if (projectOf(d.issueKey) === p) out.push({ ...d, appliesHere: false });
  }
  return out;
}

export function scopeLine(d) {
  const s = scopeOf(d);
  if (s === SCOPE.ORG) return 'Scope: ORG STANDARD — applies to every project';
  if (s === SCOPE.TEAM && d.appliesHere === false) {
    return `Scope: TEAM DECISION of project ${projectOf(d.issueKey) || '?'} — NOT a rule for your work unless it is in that project (pass issueKey to know). If you follow it elsewhere, say so; that use counts toward making it an Org standard.`;
  }
  if (s === SCOPE.TEAM) return `Scope: TEAM DECISION — applies to all work in project ${projectOf(d.issueKey) || '?'}`;
  if (d.appliesHere === false) {
    return `Scope: ISSUE DECISION of ${d.issueKey} — NOT a team rule yet. You may follow it here if it fits, but say so; this use is recorded and counts toward promoting it to a Team decision.`;
  }
  return `Scope: ISSUE DECISION — applies only to ${d.issueKey}`;
}
