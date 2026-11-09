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
        {d.status === 'stale' ? (
          <Text color="color.text.warning">The quoted text changed or disappeared in the source. Re-check, or discard if the decision changed.</Text>
        ) : null}
        {d.status === 'candidate' && conflicts.length ? (
          <SectionMessage appearance="warning" title={`Conflicts with ${conflicts.join(', ')}`}>
            <Text>{d.conflictCheck === 'agent' ? 'The AI that proposed it says it replaces a current decision.' : 'Same topic as a current decision — check whether it replaces it.'} Promote it as the replacement, or discard it.</Text>
            <Textfield placeholder="Why did the decision change? (shown to everyone who relied on the old one)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </SectionMessage>
        ) : null}
        {d.supersedes ? <Text color="color.text.subtle">Replaces {d.supersedes}{d.supersedeReason ? ` — ${d.supersedeReason}` : ''}</Text> : null}
        {d.status === 'superseded' ? <Text color="color.text.subtle">Replaced by {d.supersededBy}{d.supersedeReason ? ` — ${d.supersedeReason}` : ''}</Text> : null}
        <Inline space="space.100" shouldWrap>
          {d.status === 'candidate' ? (
            <>
              {conflicts.length ? conflicts.map((id) => (
                <Button key={id} appearance="warning" isDisabled={busy || !d.quoteVerified} onClick={() => onAct('promote', d.id, { supersede: id, reason })}>Promote, replacing {id}</Button>
              )) : <Button appearance="primary" isDisabled={busy || !d.quoteVerified} onClick={() => onAct('promote', d.id)}>Promote</Button>}
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

  const load = useCallback(async () => {
    if (!issueKey) return;
    const [list, rc, cur] = await Promise.all([invoke('list', { issueKey }), invoke('rechecks', { issueKey }), invoke('current')]);
    setItems(list);
    setRechecks(rc);
    setCurrent(cur || []);
  }, [issueKey]);

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
              options={current.filter((c) => c.issueKey !== issueKey).map((c) => ({ label: `${c.id} · ${c.title}`, value: c.id }))}
              value={pick}
              onChange={(o) => setPick(o)}
            />
          </Box>
          <Button isDisabled={busy || !pick} onClick={() => { const id = pick?.value; setPick(null); rely(id); }}>Record</Button>
        </Inline>
      ) : null}

      <Text color="color.text.subtlest">Find candidates with AI: ask the Decided agent in Rovo chat, e.g. “Find decisions in {issueKey}”, or let Claude/Cursor propose them over MCP.</Text>
      <Inline space="space.100">
        <Button isDisabled={busy} onClick={() => run(async () => {})}>Refresh</Button>
        <Button isDisabled={busy} onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : 'Add manually'}</Button>
      </Inline>

      {showForm ? (
        <Stack space="space.100">
          <Textfield placeholder="Decision (e.g. Payment retries are capped at 3)" value={form.statement} onChange={set('statement')} />
          <TextArea placeholder="Evidence quote — copy one sentence exactly from the issue or page" value={form.quote} onChange={set('quote')} />
          <Textfield placeholder="Confluence page URL (optional — default is this issue)" value={form.sourceUrl} onChange={set('sourceUrl')} />
          <Textfield placeholder="Why (optional)" value={form.rationale} onChange={set('rationale')} />
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
        <Text color="color.text.subtle">No decisions recorded on this issue yet. Ask the Decided agent in Rovo, or add one manually.</Text>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
