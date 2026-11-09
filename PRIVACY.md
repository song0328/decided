# Decided — Privacy Policy

Last updated: 10 November 2026

Decided is a Forge app that runs entirely on Atlassian's platform ("Runs on Atlassian"). It has no servers of its own and sends no data outside Atlassian.

## What the app stores
In Forge storage on your Atlassian site, Decided stores:
- decision records you or an agent create: statement, title, rationale, evidence quote, source issue key or Confluence page id/URL, status and history;
- the Atlassian account ID and display name of the person who proposed or promoted a decision, and timestamps;
- "reliance" records: which Jira issue relied on which decision, and whether the record came from a person or an MCP client.

On Jira issues, Decided adds comments and an issue property (`decided-recheck`) when a decision that work relied on changes.

## What the app reads
Jira issues (summary, description, comments), Jira user display names, and Confluence pages you point it to — only on the site where it is installed, and for `read-source` only with the calling user's own permissions.

## Sharing
The developer has no access to your data. Data is not sold, shared with third parties, or used for training. Language processing happens in Rovo or in the MCP client you choose to connect, under their own terms.

## Retention and deletion
Data stays in your site's Forge storage until you delete it or uninstall the app. Uninstalling removes the app's storage according to Atlassian's Forge data policies.

## Contact
Open an issue at https://github.com/song0328/decided/issues
