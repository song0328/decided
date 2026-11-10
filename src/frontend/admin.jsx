import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Button, Checkbox, Heading, SectionMessage, Stack, Text, UserPicker } from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const [policy, setPolicy] = useState(null);
  const [owners, setOwners] = useState([]);
  const [second, setSecond] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    invoke('getPolicy').then((p) => {
      setPolicy(p);
      setOwners(p.owners);
      setSecond(p.requireSecondPerson);
    });
  }, []);

  if (!policy) return <Text>Loading…</Text>;

  const save = async () => {
    const p = await invoke('savePolicy', { owners, requireSecondPerson: second });
    setPolicy(p);
    setNote(`Saved. ${p.owners.length ? `${p.owners.length} decision owner(s)` : 'Anyone can promote'}; ${p.requireSecondPerson ? 'a second person is required' : 'real usage or a second person'} for Team and Org.`);
  };

  return (
    <Stack space="space.200">
      <Heading size="medium">Decided — promotion policy</Heading>
      <Text>
        Anyone who can see an issue may promote a candidate to an Issue decision. Widening a decision's reach — to a Team decision
        (every agent in the project) or an Org standard (every project) — follows this policy.
      </Text>
      <UserPicker
        label="Decision owners (leave empty to let anyone promote)"
        name="owners"
        isMulti
        defaultValue={policy.owners}
        onChange={(users) => setOwners((Array.isArray(users) ? users : [users]).filter(Boolean).map((u) => u.id))}
      />
      <Checkbox
        label="Always require a second person for Team and Org promotion (usage alone is not enough)"
        name="second"
        defaultChecked={policy.requireSecondPerson}
        onChange={(e) => setSecond(Boolean(e?.target?.checked))}
      />
      <Button appearance="primary" onClick={save}>Save policy</Button>
      {note ? <SectionMessage appearance="success"><Text>{note}</Text></SectionMessage> : null}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
