# Hashavshevet MCP

Unofficial MCP (Model Context Protocol) stdio server for **חשבשבת בענן (Hashavshevet)** through the **WizCloud** REST API.

The public-facing name is **Hashavshevet MCP**. `wizcloud-mcp` remains the
package, CLI, and MCP server identifier for compatibility with the existing
Agente Desktop bundle and downstream configurations. The additive
`hashavshevet-mcp` CLI alias is also available when the package is published.

> **Disclaimer:** This is an **unofficial community client**. It is not affiliated with, endorsed by, or supported by חשבשבת / Hashavshevet / WizCloud. All product names and trademarks belong to their respective owners. Use at your own risk against your own WizCloud account and API credentials.

> **Publication note:** The source repository can be public while the npm
> package remains intentionally marked `private` until registry publication
> is explicitly approved. Do not commit credentials, portfolio files, or live
> customer data.

API reference: [docs.wizcloud.co.il REST API](https://docs.wizcloud.co.il/docs/rest-api/) and the official [Swagger definition](https://app.swaggerhub.com/apis-docs/Wizcloud/Api/1.0.0).

## Quick start

Requires Node.js ≥ 22 (24 recommended, see `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm build
```

Use `.env.example` as a template for a private environment or configure the
variables in your MCP client. The server does not load `.env` files itself.
It is stdio-based, so stdout is reserved for MCP messages and diagnostics go
to stderr.

## What it does

Exposes 7 consolidated MCP tools (over stdio) that wrap the WizCloud REST API:

| Tool | Actions | WizCloud endpoints |
| --- | --- | --- |
| `hashavshevet_companies` | `list`, `refresh` | `CompanyListToTokenApi/TokenCompanies` |
| `hashavshevet_documents` | `create_doc`, `get_doc`, `issue_document`, `create_receipt`, `create_invoice_receipt` | `invApi/createDoc`, `invApi/getDoc`, `invApi/issueDocument`, `docsApi/createRecipt`, `docsApi/createInvRecipt` |
| `hashavshevet_journal_batch` | `create_temp`, `check`, `finalize`, `issue` | `jtransApi/tmpBatch`, `jtransApi/chkBatch`, `jtransApi/newBatch`, `jtransApi/issueBatch` |
| `hashavshevet_export` | `export` | `ExportDataApi/exportData` |
| `hashavshevet_bank_pages` | `import` | `BankPagesApi/importBankPage` |
| `hashavshevet_master_data` | `import_index`, `import_sort_codes`, `import_trans_types` | `IndexApi/importIndex`, `SortCodeApi/importSortCodes`, `TransTypesApi/importTransTypes` |
| `hashavshevet_triggers` | `get`, `set`, `update`, `delete` | `TriggersApi/getURL`, `setURL`, `updateURL`, `deleteURL` |

Notes:

- `invApi/delDocument` is **deliberately not exposed**.
- Every data tool takes a required `company` argument — an exact company name or DBName from the portfolio (run `hashavshevet_companies` `list` to see them). Unknown companies are rejected with a list of known names; the server never guesses.
- Each tool takes an optional `data` object that is forwarded verbatim to the endpoint. Request schemas confirmed via the official Swagger are documented in `src/wizcloud-client.ts`; where the shape is undocumented (`TokenCompanies`, `createSession` response), the assumption is documented in code comments.
- Session handling: the server mints a `wizAuthToken` per company DB via `createSession`, caches it for 23 hours (the API's TTL is 24h), and re-mints once automatically on auth errors. The token and API key are never logged and never appear in error messages.
- The company portfolio is persisted to a local JSON file with mode `0600`; its contents are never logged.

## Configuration

Required environment variables:

| Variable | Description |
| --- | --- |
| `HASHAVSHVET_API_SERVER` | Your account's API server host, e.g. `lb1.wizcloud.co.il` |
| `HASHAVSHVET_API_TOKEN` | Your `WizcloudApiPrivateKey` |
| `HASHAVSHVET_PRIMARY_DB` | DBName used to mint the bootstrap session |

Optional:

| Variable | Description | Default |
| --- | --- | --- |
| `HASHAVSHVET_PORTFOLIO_PATH` | Path of the company portfolio store | `./hashavshevet-portfolio.json` |

### Example MCP client config (Claude Desktop / Claude Code)

The `mcpServers` key is a local label. Existing configurations using
`"wizcloud"` continue to work; new configurations can use the recognizable
`"hashavshevet"` label shown here.

```json
{
  "mcpServers": {
    "hashavshevet": {
      "command": "node",
      "args": ["/path/to/wizcloud-mcp/dist/index.js"],
      "env": {
        "HASHAVSHVET_API_SERVER": "lb1.wizcloud.co.il",
        "HASHAVSHVET_API_TOKEN": "your-private-key",
        "HASHAVSHVET_PRIMARY_DB": "YOURDB"
      }
    }
  }
}
```

## Development

```bash
pnpm install        # install dependencies
pnpm test           # run the vitest suite (all HTTP mocked)
pnpm typecheck      # tsc --noEmit
pnpm build          # tsup → single-file dist/index.js
pnpm audit --prod --audit-level high
```

All tests use mocked HTTP responses. No test requires a live WizCloud account
or credentials.

## Compatibility and release gates

- Keep the package name `wizcloud-mcp`, the `wizcloud-mcp` bin, the
  `hashavshevet_*` tool names, and the `HASHAVSHVET_*` environment variables
  stable. Renaming any of these requires an explicit migration plan.
- The `hashavshevet-mcp` bin is an additive alias; it does not replace the
  existing command.
- Repository visibility, npm publication, release tags, MCP registry listing,
  and downstream Desktop bundle updates are separate cutover steps. This
  source PR does not perform any of them.
- Before publication, run the full CI suite, review the dependency audit,
  verify the current Desktop bundle against the merged commit, and complete
  live multi-company dogfood without exposing customer data.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[RELEASING.md](RELEASING.md) for the public-repository workflow.

## Architecture

- `src/wizcloud-client.ts` — **the only file that knows endpoint paths and payload shapes.** Session cache, retry-on-401, secret redaction. If the API changes, fix it here.
- `src/portfolio.ts` — company portfolio store (TokenCompanies normalization, 0600 persistence, exact-match resolution).
- `src/tools.ts` — the 7 tool definitions (action enums, annotations, company resolution).
- `src/index.ts` — stdio server entrypoint, env validation, per-server client cache.

---

# Hashavshevet MCP (עברית)

שרת MCP לא-רשמי (stdio) עבור ה-REST API של **חשבשבת בענן (WizCloud)**.

> **כתב ויתור:** זהו קליינט קהילתי **לא-רשמי**. אין לו כל קשר, חסות או אישור מטעם חשבשבת / Hashavshevet / WizCloud. השימוש על אחריותכם בלבד, מול חשבון ה-WizCloud ופרטי ה-API שלכם.

## מה השרת עושה

חושף 7 כלי MCP מעל stdio העוטפים את ה-REST API של WizCloud:

| כלי | פעולות | נקודות קצה ב-WizCloud |
| --- | --- | --- |
| `hashavshevet_companies` | `list`, `refresh` | רשימת החברות שהטוקן רשאי לגשת אליהן (`TokenCompanies`) |
| `hashavshevet_documents` | `create_doc`, `get_doc`, `issue_document`, `create_receipt`, `create_invoice_receipt` | מסמכים: חשבוניות, קבלות, חשבונית-קבלה (`invApi`, `docsApi`) |
| `hashavshevet_journal_batch` | `create_temp`, `check`, `finalize`, `issue` | צינור אצוות פקודות יומן (`jtransApi`) |
| `hashavshevet_export` | `export` | הפקת דוחות (`ExportDataApi/exportData`) |
| `hashavshevet_bank_pages` | `import` | ייבוא דפי בנק (`BankPagesApi/importBankPage`) |
| `hashavshevet_master_data` | `import_index`, `import_sort_codes`, `import_trans_types` | ייבוא נתוני בסיס: כרטיסים, קודי מיון, סוגי תנועה |
| `hashavshevet_triggers` | `get`, `set`, `update`, `delete` | ניהול Webhooks (`TriggersApi`) |

הערות:

- `invApi/delDocument` **לא נחשף** בכוונה.
- כל כלי דורש ארגומנט `company` — שם חברה או DBName מדויק מתוך הפורטפוליו. חברה לא מוכרת נדחית עם רשימת השמות הידועים; השרת לא מנחש.
- ניהול סשן: מופק `wizAuthToken` לכל DB של חברה דרך `createSession`, נשמר במטמון ל-23 שעות (ה-TTL של ה-API הוא 24 שעות), ומחודש אוטומטית פעם אחת בשגיאת אימות. הטוקן והמפתח הפרטי לעולם אינם נרשמים בלוג ואינם מופיעים בהודעות שגיאה.
- קובץ הפורטפוליו נשמר מקומית בהרשאות `0600` ותוכנו אינו נרשם בלוג.

## הגדרה

משתני סביבה נדרשים:

| משתנה | תיאור |
| --- | --- |
| `HASHAVSHVET_API_SERVER` | שרת ה-API של החשבון, למשל `lb1.wizcloud.co.il` |
| `HASHAVSHVET_API_TOKEN` | ה-`WizcloudApiPrivateKey` שלכם |
| `HASHAVSHVET_PRIMARY_DB` | ה-DBName להפקת הסשן הראשוני |

אופציונלי: `HASHAVSHVET_PORTFOLIO_PATH` — נתיב קובץ הפורטפוליו (ברירת מחדל `./hashavshevet-portfolio.json`).

## פיתוח

נדרש Node.js ≥ 22 (מומלץ 24, ראו `.nvmrc`) ו-pnpm.

```bash
pnpm install
pnpm test        # בדיקות vitest (כל ה-HTTP מדומה)
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/index.js כקובץ יחיד
```

## רישיון

MIT — ראו [LICENSE](LICENSE).
