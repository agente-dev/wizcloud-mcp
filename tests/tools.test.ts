import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("marks read-only tools and marks the trigger delete action destructive", async () => {
    const { tools } = await mcpClient.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("hashavshevet_companies")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("hashavshevet_export")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("hashavshevet_triggers")?.annotations?.destructiveHint).toBe(true);
    for (const tool of tools) {
      if (tool.name === "hashavshevet_triggers") continue;
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

  it("refresh over a LEGACY echo body keeps the historical no-companies failure (no marker, fixed text)", async () => {
    const result = await callTool("hashavshevet_companies", { action: "refresh" });
    // The bundled test fetch answers `{ok:true, echo}` — a legacy alias shape
    // with NO company list, so refresh keeps its historical shape failure.
    // The tool result is fail() TEXT (not JSON) with NO validation marker and
    // no provider payload echo.
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toContain("no companies");
    expect(resultText(result)).not.toContain("documented-ok");
    expect(posts.map((p) => p.path)).toEqual(["CompanyListToTokenApi/TokenCompanies"]);
  });

  it("refresh over a DOCUMENTED envelope (true empty) derives documented-ok", async () => {
    const documentedFetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "native-session-xxx" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ statusCode: 200, status: { errors: "OK", repdata: [] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const nativeClient = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: documentedFetch,
    });
    const nativePortfolioPath = join(dir, "native-portfolio.json");
    const nativePortfolio = new PortfolioStore(nativePortfolioPath, "lb1.wizcloud.co.il");
    const nativeServer = new McpServer({ name: "wizcloud-mcp-native-test", version: "0.0.0" });
    registerTools(nativeServer, { clientFor: () => nativeClient, defaultClient: nativeClient, portfolio: nativePortfolio });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const nativeProbe = new Client({ name: "native-probe", version: "0.0.0" });
    await Promise.all([nativeProbe.connect(c), nativeServer.connect(s)]);
    try {
      const result = await nativeProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "refresh" } });
      const text = (result as { content: Array<{ type: string; text: string }> }).content
        .map((b) => b.text).join("\n");
      const parsed = JSON.parse(text) as { companies: unknown[]; updatedAt: string; validation?: string };
      expect(parsed).toEqual({ companies: [], updatedAt: expect.any(String), validation: "documented-ok" });
    } finally {
      await nativeProbe.close();
      await nativeServer.close();
    }
  });

  it("refresh over a missing-statusCode documented claim fails with fixed text, no marker, cache preserved", async () => {
    const missingCodeFetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "missing-code-session-xxx" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: { errors: "OK", repdata: [] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const missingCodeClient = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: missingCodeFetch,
    });
    const keepPortfolio = new PortfolioStore(join(dir, "keep-portfolio.json"), "lb1.wizcloud.co.il");
    const keepServer = new McpServer({ name: "wizcloud-mcp-keep-test", version: "0.0.0" });
    registerTools(keepServer, { clientFor: () => missingCodeClient, defaultClient: missingCodeClient, portfolio: keepPortfolio });
    const [kc, ks] = InMemoryTransport.createLinkedPair();
    const keepProbe = new Client({ name: "keep-probe", version: "0.0.0" });
    await Promise.all([keepProbe.connect(kc), keepServer.connect(ks)]);
    try {
      await keepPortfolio.save(PORTFOLIO);
      const before = await readFile(keepPortfolio.filePath, "utf8");
      const result = await keepProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "refresh" } });
      const text = (result as { content: Array<{ type: string; text: string }>; isError?: boolean }).content
        .map((b) => b.text).join("\n");
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(text).toContain("claimed the documented envelope but was malformed");
      expect(text).not.toContain("documented-ok");
      expect(await readFile(keepPortfolio.filePath, "utf8")).toBe(before);
    } finally {
      await keepProbe.close();
      await keepServer.close();
    }
  });

  it("LEGACY-COMPAT: tool refresh over {status:'OK',companies:[...]} succeeds with NO marker and one API call", async () => {
    let tokenCalls = 0;
    const legacyFetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "legacy-session-xxx" }), { status: 200 });
      }
      tokenCalls += 1;
      return new Response(
        JSON.stringify({ status: "OK", companies: [{ CompanyName: "Legacy Co", DBName: "legacy-db" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const legacyClient = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: legacyFetch,
    });
    const lStore = new PortfolioStore(join(dir, "legacy-portfolio.json"), "lb1.wizcloud.co.il");
    const lServer = new McpServer({ name: "wizcloud-mcp-legacy-test", version: "0.0.0" });
    registerTools(lServer, { clientFor: () => legacyClient, defaultClient: legacyClient, portfolio: lStore });
    const [lc, ls] = InMemoryTransport.createLinkedPair();
    const lProbe = new Client({ name: "legacy-probe", version: "0.0.0" });
    await Promise.all([lProbe.connect(lc), lServer.connect(ls)]);
    try {
      const result = await lProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "refresh" } });
      const text = (result as { content: Array<{ type: string; text: string }> }).content.map((b) => b.text).join("\n");
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      expect(text).toContain("Legacy Co");
      expect(text).not.toContain("documented-ok");
      expect(tokenCalls).toBe(1);
    } finally {
      await lProbe.close();
      await lServer.close();
    }
  });

  it("PRRT_Su: refresh of a padded Company_File_Name requests the CLEAN DB in the real session call", async () => {
    // Real WizcloudClient + real tool wiring; capture the createSession URL.
    const sessionUrls: string[] = [];
    const paddedFetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        sessionUrls.push(url);
        return new Response(JSON.stringify({ wizAuthToken: "padded-session-xxx" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          statusCode: 200,
          status: { errors: "OK", repdata: [{ Company_File_Name: "  PADDED-DB  ", Company_Name: "Padded Co" }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const paddedClient = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: paddedFetch,
    });
    const pStore = new PortfolioStore(join(dir, "padded-portfolio.json"), "lb1.wizcloud.co.il");
    const pServer = new McpServer({ name: "wizcloud-mcp-padded-test", version: "0.0.0" });
    registerTools(pServer, { clientFor: () => paddedClient, defaultClient: paddedClient, portfolio: pStore });
    const [pc, ps] = InMemoryTransport.createLinkedPair();
    const pProbe = new Client({ name: "padded-probe", version: "0.0.0" });
    await Promise.all([pProbe.connect(pc), pServer.connect(ps)]);
    try {
      const result = await pProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "refresh" } });
      const text = (result as { content: Array<{ type: string; text: string }> }).content.map((b) => b.text).join("\n");
      expect(text).toContain("PADDED-DB");
      expect(text).not.toContain("  PADDED-DB");
      // The persisted identity is clean: resolving the company and calling a
      // data tool mints the session with the CLEAN DB name.
      const list = await pProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "list" } });
      const listText = (list as { content: Array<{ type: string; text: string }> }).content.map((b) => b.text).join("\n");
      expect(listText).toContain("PADDED-DB");
      expect(listText).not.toContain("  PADDED-DB");
      const doc = await pProbe.callTool({
        name: "hashavshevet_documents",
        arguments: { action: "get_doc", company: "Padded Co", data: { stockID: 1 } },
      }).catch((e: Error) => e);
      // The session URL for the resolved company must carry the CLEAN DB.
      const companySession = sessionUrls.find((u) => u.includes("PADDED-DB"));
      expect(companySession).toBeDefined();
      expect(companySession).not.toMatch(/%20PADDED-DB|%09|PADDED-DB%20|PADDED-DB%20/);
      expect(companySession).toContain("PADDED-DB");
      expect(doc).toBeDefined();
    } finally {
      await pProbe.close();
      await pServer.close();
    }
  });

  it("PRRT_S2: tool refresh over HTTP 500 with a private payload emits the FIXED message only", async () => {
    const leak = "PRIVATE-PROVIDER-STACK-ABC";
    const failingFetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "leak-session-xxx" }), { status: 200 });
      }
      return new Response(`provider failure: ${leak}`, { status: 500 });
    }) as unknown as typeof fetch;
    const leakClient = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: failingFetch,
    });
    const lStore = new PortfolioStore(join(dir, "leak-portfolio.json"), "lb1.wizcloud.co.il");
    await lStore.save(PORTFOLIO);
    const before = await readFile(lStore.filePath, "utf8");
    const lServer = new McpServer({ name: "wizcloud-mcp-leak-test", version: "0.0.0" });
    registerTools(lServer, { clientFor: () => leakClient, defaultClient: leakClient, portfolio: lStore });
    const [lc, ls] = InMemoryTransport.createLinkedPair();
    const lProbe = new Client({ name: "leak-probe", version: "0.0.0" });
    await Promise.all([lProbe.connect(lc), lServer.connect(ls)]);
    try {
      const result = await lProbe.callTool({ name: "hashavshevet_companies", arguments: { action: "refresh" } });
      const text = (result as { content: Array<{ type: string; text: string }> }).content.map((b) => b.text).join("\n");
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(text).toContain("failed at the provider");
      expect(text).not.toContain(leak);
      expect(await readFile(lStore.filePath, "utf8")).toBe(before);
    } finally {
      await lProbe.close();
      await lServer.close();
    }
  });

  it("cached list reports the stored companies with NO validation marker and no API call", async () => {
    const result = await callTool("hashavshevet_companies", { action: "list" });
    const parsed = JSON.parse(resultText(result)) as { companies: Array<{ name: string }>; validation?: string };
    expect(parsed.companies.map((c) => c.name)).toEqual(["Acme Ltd", "Beta ביטא"]);
    expect(parsed.validation).toBeUndefined();
    expect(posts).toHaveLength(0);
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
