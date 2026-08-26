/**
 * tools.ts — the 7 consolidated MCP tools exposed by wizcloud-mcp.
 *
 * Every tool takes an `action` enum; every data tool takes a required
 * `company` string (exact company name or DBName from the portfolio) and an
 * optional passthrough `data` object forwarded verbatim to the API.
 *
 * Annotation note: MCP annotations are per-tool, not per-action. Tools whose
 * actions are all reads (hashavshevet_companies list/refresh only reads the
 * local store / API list, hashavshevet_export) get readOnlyHint: true. Tools
 * that mix reads and writes (hashavshevet_documents, hashavshevet_triggers,
 * hashavshevet_journal_batch, hashavshevet_bank_pages, hashavshevet_master_data)
 * get the safe default readOnlyHint: false, even though some of their actions
 * (get_doc, triggers get) are reads. `hashavshevet_triggers` also exposes the
 * documented deleteURL action, so its tool-level destructiveHint is true. The
 * separate invApi/delDocument endpoint remains deliberately excluded.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WizcloudClient } from "./wizcloud-client.js";
import {
  PortfolioError,
  PortfolioStore,
  unknownCompanyError,
  type Company,
} from "./portfolio.js";

export interface ToolDeps {
  /** Resolve the HTTP client for a company (handles per-company servers). */
  clientFor: (company: Company) => WizcloudClient;
  /** Client for the configured default server (used for TokenCompanies). */
  defaultClient: WizcloudClient;
  portfolio: PortfolioStore;
}

const dataArg = z
  .record(z.unknown())
  .optional()
  .describe("Payload forwarded verbatim to the WizCloud API endpoint (see tool description for the expected shape).");

const companyArg = z
  .string()
  .min(1)
  .describe("Exact company name or DBName, as listed by hashavshevet_companies.");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Resolve company → Company, throwing a listed-names error when unknown. */
async function resolveCompany(deps: ToolDeps, company: string): Promise<Company> {
  const portfolio = await deps.portfolio.loadOrRefresh(deps.defaultClient);
  const match = deps.portfolio.resolve(portfolio, company);
  if (!match) throw unknownCompanyError(company, portfolio);
  return match;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  // 1. Companies ------------------------------------------------------------
  server.registerTool(
    "hashavshevet_companies",
    {
      description:
        "List the companies (לקוחות/חברות) the WizCloud API token can access, from the local portfolio store. " +
        "Use `refresh` to re-call CompanyListToTokenApi/TokenCompanies and rewrite the store.",
      inputSchema: {
        action: z.enum(["list", "refresh"]).describe("`list` reads the local store; `refresh` re-fetches from the API and rewrites the store."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ action }) => {
      try {
        if (action === "refresh") {
          const portfolio = await deps.portfolio.refresh(deps.defaultClient);
          return ok({
            companies: portfolio.companies,
            updatedAt: portfolio.updatedAt,
          });
        }
        const portfolio = await deps.portfolio.loadOrRefresh(deps.defaultClient);
        return ok({
          companies: portfolio.companies,
          updatedAt: portfolio.updatedAt,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 2. Documents ------------------------------------------------------------
  server.registerTool(
    "hashavshevet_documents",
    {
      description:
        "Create, fetch, and issue WizCloud documents (חשבוניות/תעודות). " +
        "create_doc → invApi/createDoc (payload per official docs: { issueStock, deleteTemp, rows }). " +
        "get_doc → invApi/getDoc ({ stockID }). issue_document → invApi/issueDocument ({ stockID }). " +
        "create_receipt → docsApi/createRecipt. create_invoice_receipt → docsApi/createInvRecipt.",
      inputSchema: {
        action: z.enum(["create_doc", "get_doc", "issue_document", "create_receipt", "create_invoice_receipt"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, company, data }) => {
      try {
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        switch (action) {
          case "create_doc":
            return ok(await client.createDoc(target.dbName, data));
          case "get_doc":
            return ok(await client.getDoc(target.dbName, data));
          case "issue_document":
            return ok(await client.issueDocument(target.dbName, data));
          case "create_receipt":
            return ok(await client.createReceipt(target.dbName, data));
          case "create_invoice_receipt":
            return ok(await client.createInvoiceReceipt(target.dbName, data));
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 3. Journal batch ----------------------------------------------------------
  server.registerTool(
    "hashavshevet_journal_batch",
    {
      description:
        "Staged journal-entry batch pipeline (פקודות יומן). " +
        "create_temp → jtransApi/tmpBatch (stage rows; payload per official docs: { insertolastb, batchNo, check, issue, rows[] }). " +
        "check → jtransApi/chkBatch ({ batchNo }). finalize → jtransApi/newBatch. issue → jtransApi/issueBatch ({ batchNo }).",
      inputSchema: {
        action: z.enum(["create_temp", "check", "finalize", "issue"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, company, data }) => {
      try {
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        switch (action) {
          case "create_temp":
            return ok(await client.tmpBatch(target.dbName, data));
          case "check":
            return ok(await client.chkBatch(target.dbName, data));
          case "finalize":
            return ok(await client.newBatch(target.dbName, data));
          case "issue":
            return ok(await client.issueBatch(target.dbName, data));
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 4. Export -----------------------------------------------------------------
  server.registerTool(
    "hashavshevet_export",
    {
      description:
        "Run a WizCloud report export (הפקת דוחות) via ExportDataApi/exportData. " +
        "data = { datafile: string, parameters: string } (schema confirmed via official docs; valid datafile report identifiers are account-specific).",
      inputSchema: {
        action: z.enum(["export"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ action, company, data }) => {
      try {
        void action;
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        return ok(await client.exportData(target.dbName, data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 5. Bank pages ---------------------------------------------------------------
  server.registerTool(
    "hashavshevet_bank_pages",
    {
      description:
        "Import bank statement rows (דפי בנק) via BankPagesApi/importBankPage. " +
        "data = { rows: [{ AccountKey, Reference?, CreditDebit (1|0), SuF, Details?, DatF? }] } (schema confirmed via official docs).",
      inputSchema: {
        action: z.enum(["import"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, company, data }) => {
      try {
        void action;
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        return ok(await client.importBankPage(target.dbName, data));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 6. Master data --------------------------------------------------------------
  server.registerTool(
    "hashavshevet_master_data",
    {
      description:
        "Import master data: import_index → IndexApi/importIndex (accounts/items: { myindex: acc|itm, insertnew, rows[] }); " +
        "import_sort_codes → SortCodeApi/importSortCodes ({ myindex: accsort|itmsort, rows[] }); " +
        "import_trans_types → TransTypesApi/importTransTypes ({ rows[] }). Schemas confirmed via official docs.",
      inputSchema: {
        action: z.enum(["import_index", "import_sort_codes", "import_trans_types"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, company, data }) => {
      try {
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        switch (action) {
          case "import_index":
            return ok(await client.importIndex(target.dbName, data));
          case "import_sort_codes":
            return ok(await client.importSortCodes(target.dbName, data));
          case "import_trans_types":
            return ok(await client.importTransTypes(target.dbName, data));
        }
      } catch (err) {
        return fail(err);
      }
    },
  );

  // 7. Triggers -----------------------------------------------------------------
  server.registerTool(
    "hashavshevet_triggers",
    {
      description:
        "Manage WizCloud webhook triggers (TriggersApi). get → getURL (list registered triggers). " +
        "set → setURL ({ url, table }). update → updateURL ({ url, table, field: url|table, value }). " +
        "delete → deleteURL ({ url, table }). Tables: stock, stockmoves, accounts, items, jurnaltrans, jurnaltransmoves, bankpages, documents.",
      inputSchema: {
        action: z.enum(["get", "set", "update", "delete"]),
        company: companyArg,
        data: dataArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ action, company, data }) => {
      try {
        const target = await resolveCompany(deps, company);
        const client = deps.clientFor(target);
        switch (action) {
          case "get":
            return ok(await client.getTriggerUrl(target.dbName, data));
          case "set":
            return ok(await client.setTriggerUrl(target.dbName, data));
          case "update":
            return ok(await client.updateTriggerUrl(target.dbName, data));
          case "delete":
            return ok(await client.deleteTriggerUrl(target.dbName, data));
        }
      } catch (err) {
        return fail(err);
      }
    },
  );
}

export { PortfolioError };
