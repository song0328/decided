# Demo data — "Northwind Pay" (fictional)

Everything here is invented: the company, the people and the code.

| File | What |
|---|---|
| `northwind-pay.json` | Jira project PAY (5 issues with comments) and 3 Confluence pages. `stage: base` is loaded before a demo, `live` during it (a later meeting that changes the retry decision). |
| `seed.mjs` | Loads the data into a site: `ATLASSIAN_SITE=https://<site>.atlassian.net ATLASSIAN_EMAIL=… ATLASSIAN_API_TOKEN=… node seed.mjs [--stage live] [--dry-run]` (classic API token). |
| `northwind-pay-repo/` | A tiny charge client that still follows an outdated wiki (2 retries, fixed delay, retries card declines). In the demo, Claude Code reads the team's decisions through Decided's MCP tools and fixes it. |
| `expected-fix/` | What the fix looks like after following decisions D-1 to D-3. |

What the data exercises: a meeting note with decisions, open questions and action items; issue comments with a decision, a "not decided yet" idea and a suggestion nobody agreed to; an old onboarding page that contradicts the current decision; and a later meeting that replaces it.
