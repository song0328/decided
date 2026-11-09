# Northwind Pay — charge client

- Team decisions live in Jira/Confluence and are served by the **Decided** MCP server.
- Before changing payment behaviour (retries, limits, money handling, logging), call the Decided tool
  `find-decisions` with the topic and the Jira issue you are working on (e.g. `issueKey: "PAY-2"`),
  and follow the current decisions it returns. Mention the decision id in your commit message.
- Run `npm test` before you finish.
