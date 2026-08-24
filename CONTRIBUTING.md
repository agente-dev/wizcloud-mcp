# Contributing to Hashavshevet MCP

Thanks for helping improve this unofficial connector.

## Before opening a change

1. Read the [security policy](SECURITY.md) and do not include credentials,
   portfolio files, or customer data.
2. For API behavior changes, cite the relevant WizCloud documentation or
   describe the live-account evidence needed for follow-up. Keep undocumented
   assumptions explicit in code comments.
3. Preserve the compatibility identifiers unless the change includes a
   migration plan: `wizcloud-mcp`, `wizcloud-mcp` CLI, `hashavshevet_*` tools,
   and `HASHAVSHVET_*` environment variables.

## Local checks

Use Node.js 22 or newer and pnpm:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm typecheck
pnpm build
pnpm check-third-party-notices
pnpm verify-package-artifact
pnpm audit --prod --audit-level high
```

The tests mock all HTTP traffic. Do not add tests that require a live account
or store secrets in fixtures.

## Pull requests

Describe the user-visible effect, compatibility impact, and any remaining
publication or downstream-bundle gates. Keep branding descriptive and retain
the Hashavshevet/WizCloud unofficial-client disclaimer. A maintainer will
review both implementation quality and the stated API/spec evidence before
merge.
