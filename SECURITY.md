# Security policy

Hashavshevet MCP handles a WizCloud private key and session tokens that can
reach every company granted to that key. Treat those credentials as
high-sensitivity secrets.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/agente-dev/wizcloud-mcp/security/advisories/new).
If private advisories are unavailable, contact `security@agente.dev` and do
not include live credentials or customer data in the report.

Do not report credential exposure, authentication bypasses, or other security
issues in a public issue before maintainers have had a chance to investigate.

## Handling credentials safely

- Keep `HASHAVSHVET_API_TOKEN` outside source control and outside issue or PR
  text.
- Keep the portfolio file local; it contains customer company names and is
  expected to be mode `0600`.
- Use test doubles for automated tests. This repository's test suite must not
  contact a live WizCloud account.
- If a credential may have been exposed, revoke it in WizCloud immediately and
  then report the incident privately.
