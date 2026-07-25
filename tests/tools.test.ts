import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WizcloudClient } from "../src/wizcloud-client.js";
import { PortfolioStore, type Portfolio } from "../src/portfolio.js";
import { registerTools } from "../src/tools.js";

const SESSION_TOKEN = "test-session-zzz999";

const PORTFOLIO: Portfolio = {
  companies: [
    { name: "Acme Ltd", dbName: "ACMEDB", server: "lb1.wizcloud.co.il" },
    { name: "Beta ביטא", dbName: "BETADB", server: "lb1.wizcloud.co.il" },
  ],
  updatedAt: "2026-07-25T00:00:00.000Z",
};

interface RecordedPost {
  path: string;
  body: unknown;
  authorization: string | null;
}

let dir: string;
let posts: RecordedPost[];
let mcpClient: Client;
let mcpServer: McpServer;

function makeFetch() {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes("/createSession/")) {
      return new Response(JSON.stringify({ wizAuthToken: SESSION_TOKEN }), { status: 200 });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    posts.push({
      path: url.replace("https://lb1.wizcloud.co.il/", ""),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.Authorization ?? null,
    });
    return new Response(JSON.stringify({ ok: true, echo: posts[posts.length - 1]?.path }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

async function callTool(name: string, args: Record<string, unknown>) {
  return mcpClient.callTool({ name, arguments: args });
}

function resultText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join("\n");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wizcloud-tools-"));
  posts = [];

  const portfolioPath = join(dir, "portfolio.json");
  await writeFile(portfolioPath, JSON.stringify(PORTFOLIO), { mode: 0o600 });

  const defaultClient = new WizcloudClient({
    server: "lb1.wizcloud.co.il",
    apiToken: "test-token-xxx",
    primaryDb: "TESTDB",
    fetchImpl: makeFetch(),
  });
  const portfolio = new PortfolioStore(portfolioPath, "lb1.wizcloud.co.il");

  mcpServer = new McpServer({ name: "wizcloud-mcp-test", version: "0.0.0" });
  registerTools(mcpServer, { clientFor: () => defaultClient, defaultClient, portfolio });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcpClient = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([mcpClient.connect(clientTransport), mcpServer.connect(serverTransport)]);
});

afterEach(async () => {
  await mcpClient.close();
  await mcpServer.close();
  await rm(dir, { recursive: true, force: true });
});

describe("tools/list", () => {
  it("returns exactly the 7 consolidated tools", async () => {
    const { tools } = await mcpClient.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hashavshevet_bank_pages",
      "hashavshevet_companies",
      "hashavshevet_documents",
      "hashavshevet_export",
      "hashavshevet_journal_batch",
      "hashavshevet_master_data",
      "hashavshevet_triggers",
    ]);
  });

  it("marks read-only tools and never sets destructiveHint", async () => {
    const { tools } = await mcpClient.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("hashavshevet_companies")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("hashavshevet_export")?.annotations?.readOnlyHint).toBe(true);
    for (const tool of tools) {
      expect(tool.annotations?.destructiveHint ?? false).toBe(false);
    }
  });
});

describe("hashavshevet_companies", () => {
  it("lists companies from the store without any API call", async () => {
    const result = await callTool("hashavshevet_companies", { action: "list" });
    const parsed = JSON.parse(resultText(result)) as Portfolio;
    expect(parsed.companies.map((c) => c.name)).toEqual(["Acme Ltd", "Beta ביטא"]);
    expect(posts).toHaveLength(0);
  });

  it("refresh re-calls TokenCompanies and rewrites the store", async () => {
    const result = await callTool("hashavshevet_companies", { action: "refresh" });
    expect(resultText(result)).toContain("companies");
    expect(posts.map((p) => p.path)).toEqual(["CompanyListToTokenApi/TokenCompanies"]);
  });
});

describe("action → apiPath mapping", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["hashavshevet_documents", { action: "create_doc" }, "invApi/createDoc"],
    ["hashavshevet_documents", { action: "get_doc" }, "invApi/getDoc"],
    ["hashavshevet_documents", { action: "issue_document" }, "invApi/issueDocument"],
    ["hashavshevet_documents", { action: "create_receipt" }, "docsApi/createRecipt"],
    ["hashavshevet_documents", { action: "create_invoice_receipt" }, "docsApi/createInvRecipt"],
    ["hashavshevet_journal_batch", { action: "create_temp" }, "jtransApi/tmpBatch"],
    ["hashavshevet_journal_batch", { action: "check" }, "jtransApi/chkBatch"],
    ["hashavshevet_journal_batch", { action: "finalize" }, "jtransApi/newBatch"],
    ["hashavshevet_journal_batch", { action: "issue" }, "jtransApi/issueBatch"],
    ["hashavshevet_export", { action: "export" }, "ExportDataApi/exportData"],
    ["hashavshevet_bank_pages", { action: "import" }, "BankPagesApi/importBankPage"],
    ["hashavshevet_master_data", { action: "import_index" }, "IndexApi/importIndex"],
    ["hashavshevet_master_data", { action: "import_sort_codes" }, "SortCodeApi/importSortCodes"],
    ["hashavshevet_master_data", { action: "import_trans_types" }, "TransTypesApi/importTransTypes"],
    ["hashavshevet_triggers", { action: "get" }, "TriggersApi/getURL"],
    ["hashavshevet_triggers", { action: "set" }, "TriggersApi/setURL"],
    ["hashavshevet_triggers", { action: "update" }, "TriggersApi/updateURL"],
    ["hashavshevet_triggers", { action: "delete" }, "TriggersApi/deleteURL"],
  ];

  it.each(cases)("%s %s → %s", async (tool, args, expectedPath) => {
    posts = [];
    const result = await callTool(tool, { ...args, company: "Acme Ltd", data: { probe: 1 } });
    expect((result as { isError?: boolean }).isError ?? false).toBe(false);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(expectedPath);
    expect(posts[0]?.body).toEqual({ probe: 1 });
    expect(posts[0]?.authorization).toBe(SESSION_TOKEN);
  });
});

describe("company resolution through tools", () => {
  it("resolves by DBName too", async () => {
    const result = await callTool("hashavshevet_export", {
      action: "export",
      company: "BETADB",
      data: { datafile: "x" },
    });
    expect((result as { isError?: boolean }).isError ?? false).toBe(false);
    expect(posts[0]?.path).toBe("ExportDataApi/exportData");
  });

  it("rejects unknown companies with a listed-names error and makes no API call", async () => {
    posts = [];
    const result = await callTool("hashavshevet_export", {
      action: "export",
      company: "Nope Corp",
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = resultText(result);
    expect(text).toContain("Nope Corp");
    expect(text).toContain("Acme Ltd");
    expect(text).toContain("Beta ביטא");
    expect(posts).toHaveLength(0);
  });
});
