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
  return weigh(decision.title, 3) + weigh(decision.statement, 2) + weigh(decision.rationale, 1) + weigh(decision.issueKey, 3);
}

export function rank(decisions, query, limit = 5) {
  return decisions
    .map((d) => ({ d, s: score(d, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.d.promotedAt || 0) - (a.d.promotedAt || 0))
    .slice(0, limit)
    .map((x) => x.d);
}

/** How a decision is shown to a coding agent: short, with provenance, so it can cite it. */
export function formatForAgent(d) {
  const who = d.origin === ORIGIN.AI ? 'AI-proposed, human-promoted' : 'human-entered, human-promoted';
  const when = d.promotedAt ? new Date(d.promotedAt).toISOString().slice(0, 10) : 'unknown date';
  const lines = [
    `DECISION ${d.id}: ${d.title}`,
    `  What: ${d.statement}`,
    d.rationale ? `  Why: ${d.rationale}` : null,
    `  Evidence: "${d.quote}" — ${d.sourceUrl || d.issueKey}`,
    d.supersedes ? `  Replaces: ${d.supersedes}${d.supersedeReason ? ` (${d.supersedeReason})` : ''} — the older decision is no longer valid` : null,
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
