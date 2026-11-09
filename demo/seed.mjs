// Load the fictional "Northwind Pay" demo data into a Jira + Confluence dev site.
//
//   node seed.mjs --dry-run              # print what would be created, no network
//   node seed.mjs                        # stage "base": issues, comments, pages
//   node seed.mjs --stage live           # scene 2:20: the new PSP meeting page
//   node seed.mjs --project NWP          # same issues in another (clean) Jira project
//
// Needs ATLASSIAN_SITE (https://<name>.atlassian.net), ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN
// (a classic API token from id.atlassian.com — the Forge-scoped token is for the forge CLI only).
// Created keys/ids are written to .seeded-<site>.json so re-running skips what already exists.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'northwind-pay.json'), 'utf8'));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'base';
if (!['base', 'live'].includes(stage)) throw new Error(`--stage must be base or live, got ${stage}`);

const site = (process.env.ATLASSIAN_SITE || '').replace(/\/$/, '');
if (!dryRun && !(site && process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN)) {
  console.error('Set ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN first (or use --dry-run).');
  process.exit(1);
}
// One state file per site, so the same data can be loaded into several sites.
const statePath = join(here, `.seeded-${new URL(site || 'https://dry-run').hostname.split('.')[0]}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { issues: {}, pages: {} };
// --project KEY loads the issues into another Jira project (e.g. a clean one for a recording).
if (args.includes('--project')) data.jira.project.key = args[args.indexOf('--project') + 1];
const issueState = data.jira.project.key === 'PAY' ? 'issues' : `issues_${data.jira.project.key}`;
state[issueState] = state[issueState] || {};
const auth = 'Basic ' + Buffer.from(`${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`).toString('base64');

async function call(method, path, body) {
  const res = await fetch(site + path, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, json, text };
}

async function must(method, path, body) {
  const r = await call(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.json;
}

const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

// Plain text -> minimal Atlassian Document Format.
const adf = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function ensureProject() {
  const { key, name } = data.jira.project;
  const found = await call('GET', `/rest/api/3/project/${key}`);
  if (found.ok) return;
  const me = await must('GET', '/rest/api/3/myself');
  const created = await call('POST', '/rest/api/3/project', {
    key,
    name,
    projectTypeKey: 'software',
    projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
    leadAccountId: me.accountId,
    assigneeType: 'UNASSIGNED',
  });
  if (!created.ok) {
    throw new Error(
      `Could not create Jira project ${key} (HTTP ${created.status}). Create it by hand: ` +
        `Jira > Projects > Create project > Kanban, name "${name}", key "${key}", then run this again.`,
    );
  }
  console.log(`created Jira project ${key}`);
}

async function issueTypeId() {
  const { key } = data.jira.project;
  const res = await must('GET', `/rest/api/3/issue/createmeta/${key}/issuetypes`);
  const types = res.issueTypes || res.values || [];
  // Names are localised (e.g. Korean 「작업」), so pick by hierarchy: a standard (level 0) type, preferring Task.
  const standard = types.filter((t) => !t.subtask && (t.hierarchyLevel ?? 0) === 0);
  const pick = standard.find((t) => ['Task', '작업'].includes(t.name)) || standard[0];
  if (!pick) throw new Error(`No usable issue type in ${key}`);
  return pick.id;
}

async function seedIssues() {
  const issues = data.jira.issues.filter((i) => i.stage === stage);
  if (!issues.length) return;
  if (dryRun) {
    for (const i of issues) console.log(`[dry] issue ${i.ref}: ${i.summary} (+${(i.comments || []).length} comments)`);
    return;
  }
  await ensureProject();
  const typeId = await issueTypeId();
  for (const i of issues) {
    if (state[issueState][i.ref]) {
      console.log(`skip issue ${i.ref} = ${state[issueState][i.ref]}`);
      continue;
    }
    const res = await must('POST', '/rest/api/3/issue', {
      fields: {
        project: { key: data.jira.project.key },
        issuetype: { id: typeId },
        summary: i.summary,
        description: adf(i.description),
      },
    });
    state[issueState][i.ref] = res.key;
    save();
    for (const c of i.comments || []) await must('POST', `/rest/api/3/issue/${res.key}/comment`, { body: adf(c) });
    console.log(`created ${res.key} ${i.summary}`);
  }
}

async function ensureSpace() {
  const { key, name } = data.confluence.space;
  const found = await must('GET', `/wiki/api/v2/spaces?keys=${key}`);
  if (found.results?.length) return found.results[0].id;
  let r = await call('POST', '/wiki/api/v2/spaces', { key, name });
  if (!r.ok) r = await call('POST', '/wiki/rest/api/space', { key, name });
  if (!r.ok) throw new Error(`Could not create Confluence space ${key} (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  console.log(`created Confluence space ${key}`);
  return String(r.json.id);
}

async function seedPages() {
  const pages = data.confluence.pages.filter((p) => p.stage === stage);
  if (!pages.length) return;
  if (dryRun) {
    for (const p of pages) console.log(`[dry] page ${p.ref}: ${p.title}`);
    return;
  }
  const spaceId = await ensureSpace();
  for (const p of pages) {
    if (state.pages[p.ref]) {
      console.log(`skip page ${p.ref} = ${state.pages[p.ref].url}`);
      continue;
    }
    const res = await must('POST', '/wiki/api/v2/pages', {
      spaceId,
      status: 'current',
      title: p.title,
      body: { representation: 'storage', value: p.storage },
    });
    const url = `${site}/wiki${res._links?.webui || `/pages/${res.id}`}`;
    state.pages[p.ref] = { id: res.id, url };
    save();
    console.log(`created page ${p.title}\n  ${url}`);
  }
}

await seedIssues();
await seedPages();
if (!dryRun) {
  console.log(`\nDone. Keys and page links are in ${statePath}.`);
  console.log('Relies-on links are recorded on camera, not seeded:', JSON.stringify(data.jira.reliesOn));
}
