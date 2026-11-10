# Decided

**AI agents read everything and trust anything. In Decided, a decision earns its reach: AI proposes it, and people promote it step by step — from one issue, to the whole team, to an org standard — so every agent gets exactly the decisions that apply to its work.**

A Forge app for Jira (with optional Confluence) built for Atlassian Codegeist 2026.

## What it does

- **AI proposes, people decide.** The *Decided* Rovo agent reads a Jira issue or Confluence page and proposes the decisions in it. Each candidate must quote the source verbatim; Decided verifies the quote. A candidate becomes a team decision only when a person clicks **Promote** in the Jira issue panel. Decisions get short ids: D-1, D-2, …
- **Promotion widens a decision's reach — with evidence at every rung.** *Issue decision* (its own issue) → *Team decision* (every issue and agent in the project) → *Org standard* (every project). Each rung has checks, like CI on a pull request: the evidence quote is still in the source, **and** the decision has really been used (two other issues in the project for Team; another project for Org) **or** a second person promotes it. Decided suggests the promotion when the usage is there. A decision that replaces another inherits its reach.
- **Coding agents get only the decisions in scope, over MCP.** Through the Forge `rovo:mcp` module, Claude Code, Cursor or any MCP client can call:
  - `find-decisions` — for the issue the agent is working on: org standards, that project's team decisions and that issue's own decisions — human-promoted only, with evidence quote, source, who promoted it and what it replaced;
  - `read-source` — the text of a Jira issue or Confluence page, read with the caller's own permissions;
  - `propose-decision` — save a candidate for a human to promote.
- **Versioned, not overwritten.** A new candidate on the same subject shows *Conflicts with D-1* → **Promote, replacing D-1** (with a reason). The old one moves to History; agents only see the current one.
- **Changes reach dependent work.** Issues that relied on a decision (recorded by MCP calls or from the panel) get a comment when it is replaced or its evidence changes, and become searchable with JQL `decidedRecheck = yes`.
- **Admins set the policy.** On Decided's Jira admin page: name decision owners who alone may widen a decision's reach, and/or always require a second person for Team and Org promotion.
- **Agents see what is not a rule yet, honestly labelled.** An agent working on another issue in the same project sees an Issue decision marked *not a team rule yet*; if it follows it, that use is recorded and counts toward promotion.
- **One place to see them.** A *Decision log* page in each Jira project lists org standards, current team and issue decisions, candidates, history and the work waiting for a re-check. Decisions entered and promoted by the same person are marked *Self-promoted*.
- **Try it in three minutes.** Open any issue → Apps → Decided → **Load demo data** walks through promote → usage → *Promote to Team decision* → a later meeting that replaces it. No Rovo needed.
- **Changed evidence is flagged.** If the quoted sentence disappears from a Confluence page, the decision becomes *Needs review* for people and agents.

## Install

Use the installation link from the Devpost submission. Install into **Jira** first (required), then connect **Confluence** (optional; needed for Confluence sources and change detection). Rovo must be enabled on the site for the agent and MCP tools; the panel, the guided demo and the Decision log work without it.

### Expose the MCP tools (site admin)
admin.atlassian.com → your site → **Connected apps** → Decided → **View app details** → *Details* tab → **TOOLS** → **Enable tools**.

### Connect Claude Code
```bash
claude mcp add --transport http decided https://mcp.atlassian.com/forge/28ca58c9-2292-48ae-a069-30cae6e1040c
```
Then run `/mcp` in Claude Code → `decided` → Authenticate → choose your site. The first `read-source` call may ask you to grant the app access once.

## Develop

```bash
npm install
npm test            # 39 tests: pure logic + end-to-end resolver/MCP/trigger tests on an in-memory Forge and fake Jira/Confluence
npm run coverage    # line coverage (96%)
forge deploy
forge install       # Jira first, then Confluence
```

| Path | What |
|---|---|
| `manifest.yml` | Jira issue panel, Rovo agent, `rovo:mcp` with three actions, JQL issue property, Confluence page-updated trigger, custom entities |
| `src/core.js` | Pure logic: quote verification, promotion ladder and its checks, scope filtering, ranking, conflict pre-filter, version history, recheck comments, guided demo data |
| `src/index.js` | Resolvers, MCP actions, trigger |
| `src/frontend/index.jsx` | UI Kit issue panel (candidates, promotion ladder, conflicts, reliance, guided demo) |
| `src/frontend/log.jsx` | Decision log project page |
| `src/frontend/admin.jsx` | Promotion policy (Jira admin page) |
| `test/` | `core.test.js` (pure logic), `resolvers.test.js` (end-to-end with mocked Forge modules) |
| `demo/` | Fictional "Northwind Pay" demo data, a seed script, and a small demo repository |

**Runs on Atlassian:** all data stays in Forge storage on your site — no external hosting, no egress. The app runs no LLM of its own: language understanding is done by Rovo or by the user's coding agent, and Decided does the deterministic parts (verification, promotion, versioning, propagation).

## Privacy & terms
[PRIVACY.md](PRIVACY.md) · [TERMS.md](TERMS.md) · MIT licensed ([LICENSE](LICENSE)). All demo data is fictional.
