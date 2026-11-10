import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Button, Heading, Inline, Link, Lozenge, SectionMessage, Select, Stack, Text, TextArea, Textfield, useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const LABEL = {
  candidate: ['Candidate', 'information'],
  promoted: ['Decided', 'success'],
  stale: ['Needs review', 'warning'],
  discarded: ['Discarded', 'neutral'],
  superseded: ['Replaced', 'neutral'],
};

const SCOPE = {
  issue: ['Issue decision', 'neutral', 'Applies only to this issue.'],
  team: ['Team decision', 'information', 'Applies to all work in this project — every agent working here receives it.'],
  org: ['Org standard', 'discovery', 'Applies to every project on this site.'],
};
const SCOPE_NAME = { team: 'Team decision', org: 'Org standard' };

/** The promotion ladder for a current decision: what it applies to now, and what it would take to widen it. */
function Ladder({ d, onAct, busy }) {
  const [label, look, meaning] = SCOPE[d.scope] || SCOPE.team;
  const l = d.ladder;
  return (
    <Stack space="space.050">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <Lozenge appearance={look}>{label}</Lozenge>
        <Text color="color.text.subtle">{meaning}</Text>
      </Inline>
      {d.usage && (d.usage.issues || d.usage.otherProjects.length) ? (
        <Text color="color.text.subtlest">
          Used by {d.usage.issues} other issue(s){d.usage.otherProjects.length ? `, including projects ${d.usage.otherProjects.join(', ')}` : ''}.
        </Text>
      ) : null}
      {l && l.target ? (
        <SectionMessage appearance={l.suggested ? 'discovery' : 'information'} title={l.suggested ? `Ready to become a ${SCOPE_NAME[l.target]}` : `Promote to ${SCOPE_NAME[l.target]}`}>
          {l.checks.map((c) => <Text key={c.key}>{c.ok ? '✅' : '⬜'} {c.label}</Text>)}
          {l.rule ? <Text color="color.text.subtlest">{l.rule}</Text> : null}
          <Button appearance={l.suggested ? 'primary' : 'default'} isDisabled={busy || !l.allowed} onClick={() => onAct('promoteScope', d.id)}>
            Promote to {SCOPE_NAME[l.target]}
          </Button>
        </SectionMessage>
      ) : null}
    </Stack>
  );
}

function DecisionCard({ d, onAct, onRely, busy }) {
  const [label, look] = LABEL[d.status] || [d.status, 'neutral'];
  const [reason, setReason] = useState('');
  const conflicts = (d.conflictsWith || '').split(',').filter(Boolean);
  return (
    <Box xcss={{ padding: 'space.100', borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.small' }}>
      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text weight="bold">{d.id}</Text>
          <Lozenge appearance={look}>{label}</Lozenge>
          <Lozenge appearance={d.origin === 'ai' ? 'discovery' : 'neutral'}>{d.origin === 'ai' ? 'AI-proposed' : 'Human-entered'}</Lozenge>
          <Lozenge appearance={d.quoteVerified ? 'success' : 'danger'}>{d.quoteVerified ? 'Quote verified' : 'Quote not found'}</Lozenge>
        </Inline>
        <Text weight="bold">{d.title}</Text>
        {d.statement !== d.title ? <Text>{d.statement}</Text> : null}
        {d.rationale ? <Text color="color.text.subtle">Why: {d.rationale}</Text> : null}
        <Text color="color.text.subtle">
          “{d.quote}” — {d.sourceUrl ? <Link href={d.sourceUrl} openNewTab>{d.sourceTitle || 'source'}</Link> : 'this issue'}
        </Text>
        {d.status === 'promoted' && d.promotedByName ? (
          <Text color="color.text.subtlest">Promoted by {d.promotedByName} · {new Date(d.promotedAt).toLocaleDateString()}</Text>
        ) : null}
        {d.selfPromoted && (d.status === 'promoted' || d.status === 'stale') ? (
          <Inline space="space.050" alignBlock="center">
            <Lozenge appearance="warning">Self-promoted</Lozenge>
            <Text color="color.text.subtlest">Entered and promoted by the same person — no second reviewer.</Text>
          </Inline>
        ) : null}
        {d.status === 'candidate' && d.origin === 'human' && d.proposedByName ? (
          <Text color="color.text.subtlest">Entered by {d.proposedByName}. Ideally someone else promotes it.</Text>
        ) : null}
        {d.status === 'stale' ? (
          <Text color="color.text.warning">The quoted text changed or disappeared in the source. Re-check, or discard if the decision changed.</Text>
        ) : null}
        {d.status === 'candidate' && conflicts.length ? (
          <SectionMessage appearance="warning" title={`Conflicts with ${conflicts.join(', ')}`}>
            <Text>{d.conflictCheck === 'agent' ? (d.origin === 'ai' ? 'The AI that proposed it says it replaces a current decision.' : 'Its proposer says it replaces a current decision.') : 'Same topic as a current decision — check whether it replaces it.'} Promote it as the replacement, or discard it.</Text>
            <Textfield placeholder="Why did the decision change? (shown to everyone who relied on the old one)" onChange={(e) => setReason(e.target.value)} />
          </SectionMessage>
        ) : null}
        {d.status === 'promoted' ? <Ladder d={d} onAct={onAct} busy={busy} /> : null}
        {d.supersedes ? <Text color="color.text.subtle">Replaces {d.supersedes}{d.supersedeReason ? ` — ${d.supersedeReason}` : ''}</Text> : null}
        {d.status === 'superseded' ? <Text color="color.text.subtle">Replaced by {d.supersededBy}{d.supersedeReason ? ` — ${d.supersedeReason}` : ''}</Text> : null}
        <Inline space="space.100" shouldWrap>
          {d.status === 'candidate' ? (
            <>
              {conflicts.map((id) => (
                <Button key={id} appearance="warning" isDisabled={busy || !d.quoteVerified} onClick={() => onAct('promote', d.id, { supersede: id, reason })}>Promote, replacing {id}</Button>
              ))}
              <Button appearance={conflicts.length ? 'default' : 'primary'} isDisabled={busy || !d.quoteVerified} onClick={() => onAct('promote', d.id)}>{conflicts.length ? 'Promote, keep both' : 'Promote'}</Button>
              <Button appearance="subtle" isDisabled={busy} onClick={() => onAct('discard', d.id)}>Discard</Button>
            </>
          ) : null}
          {d.status === 'promoted' && onRely ? (
            <Button appearance="subtle" isDisabled={busy} onClick={() => onRely(d.id)}>This issue relies on it</Button>
          ) : null}
          {d.status === 'stale' ? (
            <>
              <Button isDisabled={busy} onClick={() => onAct('recheck', d.id)}>Re-check</Button>
              <Button appearance="subtle" isDisabled={busy} onClick={() => onAct('discard', d.id)}>Discard</Button>
            </>
          ) : null}
        </Inline>
      </Stack>
    </Box>
  );
}

const App = () => {
  const context = useProductContext();
  const issueKey = context?.extension?.issue?.key;
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ statement: '', quote: '', sourceUrl: '', rationale: '' });
  const [showForm, setShowForm] = useState(false);

  const [rechecks, setRechecks] = useState(null);
  const [current, setCurrent] = useState([]);
  const [pick, setPick] = useState(null);
  const [demo, setDemo] = useState(null);
  const projectKey = context?.extension?.project?.key;

  const load = useCallback(async () => {
    if (!issueKey) return;
    const [list, rc, cur, dm] = await Promise.all([
      invoke('list', { issueKey }), invoke('rechecks', { issueKey }), invoke('current', { issueKey }),
      projectKey ? invoke('demoState', { projectKey }) : null,
    ]);
    setItems(list);
    setRechecks(rc);
    setCurrent(cur || []);
    setDemo(dm);
  }, [issueKey, projectKey]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const act = (name, id, extra = {}) => run(async () => {
    const r = await invoke(name, { id, ...extra });
    if (r?.flagged) setNote(`Replaced ${extra.supersede}. ${r.flagged} issue(s) that relied on it were asked to re-check.`);
  });
  const rely = (id) => run(async () => {
    await invoke('relyOn', { id, issueKey });
    setNote('Recorded. If this decision changes, this issue will be flagged.');
  });
  const add = () => run(async () => {
    await invoke('add', { issueKey, ...form });
    setForm({ statement: '', quote: '', sourceUrl: '', rationale: '' });
    setShowForm(false);
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (!issueKey) return <Text>Loading…</Text>;
  const list = items || [];
  const group = (s) => list.filter((d) => d.status === s);
  const decided = group('promoted');
  const stale = group('stale');
  const candidates = group('candidate');

  return (
    <Stack space="space.200">
      <Text color="color.text.subtle">AI proposes, people decide. Only promoted decisions are served to coding agents (Rovo MCP).</Text>
      {error ? <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage> : null}
      {note ? <SectionMessage appearance="information"><Text>{note}</Text></SectionMessage> : null}
      {rechecks?.open ? (
        <SectionMessage appearance="warning" title="A decision this work relied on has changed">
          {rechecks.relied.filter((r) => r.status !== 'promoted').map((r) => (
            <Text key={r.id}>{r.id} — {r.title}: {r.status === 'superseded' ? `replaced by ${r.supersededBy}` : 'needs review'}</Text>
          ))}
          <Button isDisabled={busy} onClick={() => run(() => invoke('markRechecked', { issueKey }))}>I re-checked this work</Button>
        </SectionMessage>
      ) : null}
      {rechecks && !rechecks.open && rechecks.relied.length ? (
        <Text color="color.text.subtlest">This work relies on {rechecks.relied.map((r) => r.id).join(', ')}. You'll be told here if one changes.</Text>
      ) : null}
      {current.some((c) => c.issueKey !== issueKey) ? (
        <Inline space="space.100" alignBlock="center">
          <Box xcss={{ width: '70%' }}>
            <Select
              placeholder="This work relies on a team decision…"
              options={current.filter((c) => c.issueKey !== issueKey).map((c) => ({ label: `${c.id} · ${c.title}${c.project && c.project !== issueKey.split('-')[0] ? ` (${c.scope === 'org' ? 'Org standard' : `Team decision of ${c.project}`})` : ''}`, value: c.id }))}
              value={pick}
              onChange={(o) => setPick(o)}
            />
          </Box>
          <Button isDisabled={busy || !pick} onClick={() => { const id = pick?.value; setPick(null); rely(id); }}>Record</Button>
        </Inline>
      ) : null}

      {demo && demo.step !== 'done' ? (
        <SectionMessage appearance="discovery" title="Try Decided in 3 minutes (no Rovo needed)">
          {demo.step === 'start' ? (
            <>
              <Text>Creates 3 fictional issues in {projectKey} (“Northwind Pay” payments team) with meeting comments, and 3 decision candidates whose quotes Decided checks against those comments.</Text>
              <Button appearance="primary" isDisabled={busy} onClick={() => run(async () => {
                const s = await invoke('demoStart', { projectKey });
                setNote(`Demo ready. Open ${s.issues.retry} and promote ${s.capId} in its Decided panel.`);
              })}>Load demo data</Button>
            </>
          ) : null}
          {demo.step === 'promote' ? (
            <Text>Step 1 of 4: open <Link href={`/browse/${demo.state.issues.retry}`}>{demo.state.issues.retry}</Link> and click Promote on {demo.state.capId} (“Payment retries capped at 3”). It becomes an Issue decision — it applies to that issue only.</Text>
          ) : null}
          {demo.step === 'use' ? (
            <>
              <Text>Step 2 of 4: other work starts using {demo.state.capId}: a coding agent fixing {demo.state.issues['charge-client']} looks it up over MCP, and a teammate links {demo.state.issues['checkout-msg']} to it.</Text>
              <Button appearance="primary" isDisabled={busy} onClick={() => run(async () => {
                await invoke('demoUse', { projectKey });
                setNote(`${demo.state.capId} is now used by 2 other issues. On ${demo.state.issues.retry}, its card says “Ready to become a Team decision”.`);
              })}>Simulate two pieces of work using it</Button>
            </>
          ) : null}
          {demo.step === 'team' ? (
            <Text>Step 3 of 4: on <Link href={`/browse/${demo.state.issues.retry}`}>{demo.state.issues.retry}</Link>, {demo.state.capId} shows its promotion checks. Click “Promote to Team decision” — from now on every agent working in {projectKey} receives it.</Text>
          ) : null}
          {demo.step === 'change' ? (
            <>
              <Text>Step 4 of 4: {demo.state.capId} is a Team decision used by {demo.state.issues['charge-client']} and {demo.state.issues['checkout-msg']}. Simulate a later meeting that changes the rule:</Text>
              <Button appearance="primary" isDisabled={busy} onClick={() => run(async () => {
                const s = await invoke('demoChange', { projectKey });
                setNote(`New candidate ${s.changeId} conflicts with ${s.capId}. On ${s.issues.retry}, click “Promote, replacing ${s.capId}”, then open ${s.issues['charge-client']} or search JQL: decidedRecheck = yes.`);
              })}>Simulate the 2 Dec meeting</Button>
            </>
          ) : null}
        </SectionMessage>
      ) : null}

      <Text color="color.text.subtlest">Find candidates with AI: ask the Decided agent in Rovo chat (“Find decisions in {issueKey}”) or let Claude/Cursor propose them over MCP. No Rovo on this site? Use “Add manually” — copy one sentence from a comment as the quote.</Text>
      <Inline space="space.100">
        <Button isDisabled={busy} onClick={() => run(async () => {})}>Refresh</Button>
        <Button isDisabled={busy} onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : 'Add manually'}</Button>
      </Inline>

      {showForm ? (
        <Stack space="space.100">
          <Textfield placeholder="Decision (e.g. Payment retries are capped at 3)" onChange={set('statement')} />
          <TextArea placeholder="Evidence quote — copy one sentence exactly from the issue or page" onChange={set('quote')} />
          <Textfield placeholder="Confluence page URL (optional — default is this issue)" onChange={set('sourceUrl')} />
          <Textfield placeholder="Why (optional)" onChange={set('rationale')} />
          <Button appearance="primary" isDisabled={busy || !form.statement || !form.quote} onClick={add}>Save as candidate</Button>
        </Stack>
      ) : null}

      {items === null ? <Text>Loading…</Text> : null}
      {stale.length ? <Heading size="xsmall">Needs review ({stale.length})</Heading> : null}
      {stale.map((d) => <DecisionCard key={d.id} d={d} onAct={act} busy={busy} />)}
      {candidates.length ? <Heading size="xsmall">Candidates ({candidates.length})</Heading> : null}
      {candidates.map((d) => <DecisionCard key={d.id} d={d} onAct={act} busy={busy} />)}
      {decided.length ? <Heading size="xsmall">Decided ({decided.length})</Heading> : null}
      {decided.map((d) => <DecisionCard key={d.id} d={d} onAct={act} onRely={rely} busy={busy} />)}
      {group('superseded').length ? <Heading size="xsmall">History ({group('superseded').length})</Heading> : null}
      {group('superseded').map((d) => <DecisionCard key={d.id} d={d} onAct={act} busy={busy} />)}
      {items && !stale.length && !candidates.length && !decided.length ? (
        <Text color="color.text.subtle">No decisions recorded on this issue yet. Ask the Decided agent in Rovo, add one manually, or load the demo above.</Text>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
