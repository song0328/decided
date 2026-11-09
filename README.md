# Decided

**AI agents read everything and trust anything. Decided turns Jira and Confluence into the place where your team's decisions are verified, versioned and enforced — for people and for AI.**

A Forge app for Jira (with optional Confluence) built for Atlassian Codegeist 2026.

## What it does

- **AI proposes, people decide.** The *Decided* Rovo agent reads a Jira issue or Confluence page and proposes the decisions in it. Each candidate must quote the source verbatim; Decided verifies the quote. A candidate becomes a team decision only when a person clicks **Promote** in the Jira issue panel. Decisions get short ids: D-1, D-2, …
- **Coding agents get only confirmed decisions, over MCP.** Through the Forge `rovo:mcp` module, Claude Code, Cursor or any MCP client can call:
  - `find-decisions` — current, human-promoted decisions about a topic, with evidence quote, source, who promoted it and what it replaced;
  - `read-source` — the text of a Jira issue or Confluence page, read with the caller's own permissions;
  - `propose-decision` — save a candidate for a human to promote.
- **Versioned, not overwritten.** A new candidate on the same subject shows *Conflicts with D-1* → **Promote, replacing D-1** (with a reason). The old one moves to History; agents only see the current one.
- **Changes reach dependent work.** Issues that relied on a decision (recorded by MCP calls or from the panel) get a comment when it is replaced or its evidence changes, and become searchable with JQL `decidedRecheck = yes`.
- **Changed evidence is flagged.** If the quoted sentence disappears from a Confluence page, the decision becomes *Needs review* for people and agents.

## Install

Use the installation link from the Devpost submission. Install into **Jira** first (required), then connect **Confluence** (optional; needed for Confluence sources and change detection). Rovo must be enabled on the site.

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
npm test            # unit tests for the pure logic in src/core.js
forge deploy
forge install       # Jira first, then Confluence
```

| Path | What |
|---|---|
| `manifest.yml` | Jira issue panel, Rovo agent, `rovo:mcp` with three actions, JQL issue property, Confluence page-updated trigger, custom entities |
| `src/core.js` | Pure logic: quote verification, ranking, conflict pre-filter, version history, recheck comments |
| `src/index.js` | Resolvers, MCP actions, trigger |
| `src/frontend/index.jsx` | UI Kit panel |
| `demo/` | Fictional "Northwind Pay" demo data, a seed script, and a small demo repository |

The app runs no LLM of its own: language understanding is done by Rovo or by the user's coding agent, and Decided does the deterministic parts (verification, promotion, versioning, propagation).

## Privacy & terms
[PRIVACY.md](PRIVACY.md) · [TERMS.md](TERMS.md) · MIT licensed ([LICENSE](LICENSE)). All demo data is fictional.
