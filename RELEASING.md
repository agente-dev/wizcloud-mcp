# Releasing Hashavshevet MCP

This repository separates source readiness from external publication. The
following gates require an explicit maintainer/operator decision and are not
performed by an ordinary code PR:

1. Confirm the public repository description, license, security reporting path,
   and trademark disclaimer.
2. Confirm CI is green from the exact commit to be published and that the
   production dependency audit has no high-severity findings.
3. Complete live multi-company dogfood, including company routing, session
   renewal, and the governed write flows in the downstream Desktop connector.
4. Update the pinned Desktop bundle and its version marker to the exact merged
   commit; verify the packaged carrier, not only a source checkout.
5. Change GitHub visibility to public. This is an administrative cutover and
   must not be hidden in a code change.
6. Decide separately whether to publish a registry package, create a release,
   or submit to an MCP registry. The package currently remains `private: true`
   as an accidental-publish guard.
7. After the cutover, verify the public clone, CI, package metadata, links,
   security settings, and downstream Desktop runtime. Record the exact commit
   and any follow-up issues.
8. Confirm the authoritative legal copyright owner for `LICENSE` before
   publication. This source PR intentionally leaves the current
   `Copyright (c) 2026 Agente` notice unchanged and makes no rights-holder
   determination without authoritative evidence.

The package and CLI identifiers remain `wizcloud-mcp` for compatibility. The
human-facing product name is Hashavshevet MCP; the `hashavshevet-mcp` CLI alias
is additive.
