import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box, Button, Heading, Inline, Link, Lozenge, SectionMessage, Stack, Text, useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const date = (t) => (t ? new Date(t).toLocaleDateString() : '');
const SCOPE = { issue: ['Issue decision', 'neutral'], team: ['Team decision', 'information'], org: ['Org standard', 'discovery'] };
const scopeOf = (d) => (SCOPE[d.scope] ? d.scope : 'team');

function Row({ d, children }) {
  return (
    <Box xcss={{ padding: 'space.100', borderColor: 'color.border', borderWidth: 'border.width', borderStyle: 'solid', borderRadius: 'radius.small' }}>
      <Stack space="space.050">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text weight="bold">{d.id}</Text>
          <Text weight="bold">{d.title}</Text>
          <Lozenge appearance={d.origin === 'ai' ? 'discovery' : 'neutral'}>{d.origin === 'ai' ? 'AI-proposed' : 'Human-entered'}</Lozenge>
          {d.status === 'promoted' ? <Lozenge appearance={SCOPE[scopeOf(d)][1]}>{SCOPE[scopeOf(d)][0]}</Lozenge> : null}
          {d.selfPromoted ? <Lozenge appearance="warning">Self-promoted</Lozenge> : null}
        </Inline>
        {d.statement !== d.title ? <Text>{d.statement}</Text> : null}
        <Text color="color.text.subtle">
          “{d.quote}” — {d.sourceUrl ? <Link href={d.sourceUrl} openNewTab>{d.sourceTitle || 'source'}</Link> : <Link href={`/browse/${d.issueKey}`}>{d.issueKey}</Link>}
        </Text>
        {children}
      </Stack>
    </Box>
  );
}

const App = () => {
  const context = useProductContext();
  const projectKey = context?.extension?.project?.key;
  const [log, setLog] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    if (!projectKey) return;
    setError('');
    try {
      setLog(await invoke('log', { projectKey }));
    } catch (e) {
      setError(e?.message || String(e));
    }
  };
  useEffect(() => { load(); }, [projectKey]);

  if (!projectKey || (!log && !error)) return <Text>Loading…</Text>;
  if (error) return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;

  const empty = !log.current.length && !log.review.length && !log.candidates.length && !log.history.length;
  return (
    <Stack space="space.300">
      <Stack space="space.100">
        <Text color="color.text.subtle">What this team has decided, with evidence. Coding agents receive only the decisions under “Current” (via the Decided MCP tools).</Text>
        <Inline space="space.200" shouldWrap>
          <Lozenge appearance="success">{`${log.current.length} current`}</Lozenge>
          <Lozenge appearance="warning">{`${log.review.length} need review`}</Lozenge>
          <Lozenge appearance="information">{`${log.candidates.length} waiting to be promoted`}</Lozenge>
          <Lozenge appearance="danger">{`${log.recheck.length} issues to re-check`}</Lozenge>
          <Button appearance="subtle" onClick={load}>Refresh</Button>
        </Inline>
      </Stack>

      {empty ? (
        <SectionMessage appearance="information" title="No decisions yet">
          <Text>Open any issue in {projectKey} → Apps → Decided, then “Load demo data”, ask the Decided agent in Rovo, or add a decision manually.</Text>
        </SectionMessage>
      ) : null}

      {log.recheck.length ? (
        <Stack space="space.100">
          <Heading size="small">Work to re-check</Heading>
          <Text color="color.text.subtle">These issues relied on a decision that has since been replaced or lost its evidence.</Text>
          {log.recheck.map((i) => (
            <Text key={i.key}><Link href={`/browse/${i.key}`}>{i.key}</Link> — {i.summary}</Text>
          ))}
        </Stack>
      ) : null}

      {log.review.length ? (
        <Stack space="space.100">
          <Heading size="small">Needs review</Heading>
          {log.review.map((d) => (
            <Row key={d.id} d={d}><Text color="color.text.warning">The quoted text changed in the source on {date(d.staleSince)}. Agents are told not to rely on it.</Text></Row>
          ))}
        </Stack>
      ) : null}

      {log.org && log.org.length ? (
        <Stack space="space.100">
          <Heading size="small">Org standards (every project)</Heading>
          {log.org.map((d) => (
            <Row key={d.id} d={d}><Text color="color.text.subtlest">From {d.issueKey} · promoted to org standard {date(d.scopeAt)}</Text></Row>
          ))}
        </Stack>
      ) : null}

      {log.current.length ? (
        <Stack space="space.100">
          <Heading size="small">Current in {projectKey}</Heading>
          <Text color="color.text.subtle">Team decisions apply to all work in {projectKey}; issue decisions only to their own issue until they are promoted.</Text>
          {[...log.current].sort((a, b) => ['org', 'team', 'issue'].indexOf(scopeOf(a)) - ['org', 'team', 'issue'].indexOf(scopeOf(b))).map((d) => (
            <Row key={d.id} d={d}>
              <Text color="color.text.subtlest">
                Promoted {date(d.promotedAt)}{d.promotedByName ? ` by ${d.promotedByName}` : ''}{d.supersedes ? ` · replaces ${d.supersedes}${d.supersedeReason ? ` (${d.supersedeReason})` : ''}` : ''}
              </Text>
            </Row>
          ))}
          {log.selfPromoted ? (
            <Text color="color.text.subtlest">{`${log.selfPromoted} of these were entered and promoted by the same person, with no second reviewer.`}</Text>
          ) : null}
        </Stack>
      ) : null}

      {log.candidates.length ? (
        <Stack space="space.100">
          <Heading size="small">Waiting to be promoted</Heading>
          {log.candidates.map((d) => (
            <Row key={d.id} d={d}>
              <Text color="color.text.subtlest">
                {d.quoteVerified ? 'Quote verified' : 'Quote not found in source'} · open <Link href={`/browse/${d.issueKey}`}>{d.issueKey}</Link> to promote or discard
              </Text>
            </Row>
          ))}
        </Stack>
      ) : null}

      {log.history.length ? (
        <Stack space="space.100">
          <Heading size="small">History</Heading>
          {log.history.map((d) => (
            <Row key={d.id} d={d}>
              <Text color="color.text.subtlest">Replaced by {d.supersededBy}{d.supersedeReason ? ` — ${d.supersedeReason}` : ''}</Text>
            </Row>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
