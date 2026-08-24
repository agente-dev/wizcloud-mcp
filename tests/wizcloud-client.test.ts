import { describe, expect, it, vi } from "vitest";
import { SESSION_TTL_MS, WizcloudApiError, WizcloudClient, redactSecrets } from "../src/wizcloud-client.js";

const API_TOKEN = "test-token-xxx";
const SESSION_TOKEN = "test-session-aaa111";
const SESSION_TOKEN_2 = "test-session-bbb222";

interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function makeFetch(handlers: {
  sessionBodies?: string[];
  onPost?: (url: string, body: unknown, callIndex: number) => Response;
}) {
  const requests: RecordedRequest[] = [];
  let sessionCalls = 0;
  let postCalls = 0;
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, authorization: headers.Authorization ?? null, body });

    if (url.includes("/createSession/")) {
      const bodies = handlers.sessionBodies ?? [JSON.stringify({ wizAuthToken: SESSION_TOKEN })];
      const text = bodies[Math.min(sessionCalls, bodies.length - 1)] ?? "";
      sessionCalls += 1;
      return new Response(text, { status: 200 });
    }
    postCalls += 1;
    if (handlers.onPost) return handlers.onPost(url, body, postCalls - 1);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

function makeClient(fetchImpl: typeof fetch, now?: () => number) {
  return new WizcloudClient({
    server: "lb1.wizcloud.co.il",
    apiToken: API_TOKEN,
    primaryDb: "TESTDB",
    fetchImpl,
    now,
  });
}

describe("WizcloudClient sessions", () => {
  it("mints a session via createSession and sends it as Authorization", async () => {
    const { fetchImpl, requests } = makeFetch({});
    const client = makeClient(fetchImpl);

    await client.getDoc("TESTDB", { stockID: 1 });

    const session = requests[0];
    expect(session?.method).toBe("GET");
    expect(session?.url).toBe(`https://lb1.wizcloud.co.il/createSession/${API_TOKEN}/TESTDB`);
    const post = requests[1];
    expect(post?.url).toBe("https://lb1.wizcloud.co.il/invApi/getDoc");
    expect(post?.authorization).toBe(SESSION_TOKEN);
  });

  it("reuses the cached session across calls within 23h", async () => {
    const { fetchImpl, requests } = makeFetch({});
    const client = makeClient(fetchImpl);

    await client.getDoc("TESTDB", { stockID: 1 });
    await client.getDoc("TESTDB", { stockID: 2 });
    await client.getDoc("TESTDB", { stockID: 3 });

    const sessionCalls = requests.filter((r) => r.url.includes("/createSession/"));
    expect(sessionCalls).toHaveLength(1);
  });

  it("re-mints after 23h", async () => {
    let now = 1_000_000;
    const { fetchImpl, requests } = makeFetch({});
    const client = makeClient(fetchImpl, () => now);

    await client.getDoc("TESTDB", { stockID: 1 });
    now += SESSION_TTL_MS; // exactly at TTL → expired
    await client.getDoc("TESTDB", { stockID: 2 });

    const sessionCalls = requests.filter((r) => r.url.includes("/createSession/"));
    expect(sessionCalls).toHaveLength(2);
  });

  it("re-mints once and retries on 401", async () => {
    const { fetchImpl, requests } = makeFetch({
      sessionBodies: [
        JSON.stringify({ wizAuthToken: SESSION_TOKEN }),
        JSON.stringify({ wizAuthToken: SESSION_TOKEN_2 }),
      ],
      onPost: (_url, _body, callIndex) => {
        if (callIndex === 0) return new Response("nope", { status: 401 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const client = makeClient(fetchImpl);

    const result = await client.getDoc("TESTDB", { stockID: 1 });
    expect(result).toEqual({ ok: true });

    const sessionCalls = requests.filter((r) => r.url.includes("/createSession/"));
    expect(sessionCalls).toHaveLength(2);
    const posts = requests.filter((r) => r.method === "POST" && !r.url.includes("/createSession/"));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.authorization).toBe(SESSION_TOKEN);
    expect(posts[1]?.authorization).toBe(SESSION_TOKEN_2);
  });

  it("gives up after a single retry when the new session is also rejected", async () => {
    const { fetchImpl } = makeFetch({
      onPost: () => new Response("unauthorized", { status: 401 }),
    });
    const client = makeClient(fetchImpl);
    await expect(client.getDoc("TESTDB", { stockID: 1 })).rejects.toBeInstanceOf(WizcloudApiError);
  });
});

describe("redaction", () => {
  it("never includes the session token in thrown API errors", async () => {
    const { fetchImpl } = makeFetch({
      onPost: () =>
        new Response(`failure echoes auth=${SESSION_TOKEN} and key=${API_TOKEN}`, { status: 500 }),
    });
    const client = makeClient(fetchImpl);

    const err = await client.getDoc("TESTDB", { stockID: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WizcloudApiError);
    const message = (err as Error).message;
    expect(message).not.toContain(SESSION_TOKEN);
    expect(message).not.toContain(API_TOKEN);
    expect(message).toContain("[REDACTED]");
  });

  it("redactSecrets replaces every occurrence", () => {
    expect(redactSecrets("a test-token-xxx b test-token-xxx", ["test-token-xxx"])).toBe(
      "a [REDACTED] b [REDACTED]",
    );
  });

  it("redacts an encoded API key from a network error", async () => {
    const apiToken = "test/token?key=1";
    const encodedToken = encodeURIComponent(apiToken);
    const fetchImpl = (async () => {
      throw new Error(`request failed for /createSession/${encodedToken}/TESTDB`);
    }) as unknown as typeof fetch;
    const client = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken,
      primaryDb: "TESTDB",
      fetchImpl,
    });

    const err = await client.getDoc("TESTDB", { stockID: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WizcloudApiError);
    expect((err as Error).message).not.toContain(encodedToken);
    expect((err as Error).message).toContain("[REDACTED]");
  });
});

describe("endpoint wrappers", () => {
  it("map to the documented apiPaths with POST + JSON body", async () => {
    const { fetchImpl, requests } = makeFetch({});
    const client = makeClient(fetchImpl);

    await client.tmpBatch("TESTDB", { rows: [] });
    await client.chkBatch("TESTDB", { batchNo: 5 });
    await client.newBatch("TESTDB");
    await client.issueBatch("TESTDB", { batchNo: 5 });
    await client.createDoc("TESTDB", { rows: {} });
    await client.getDoc("TESTDB", { stockID: 7 });
    await client.issueDocument("TESTDB", { stockID: 7 });
    await client.createReceipt("TESTDB", { rows: {} });
    await client.createInvoiceReceipt("TESTDB", { data: {} });
    await client.exportData("TESTDB", { datafile: "journal", parameters: "{}" });
    await client.importBankPage("TESTDB", { rows: [] });
    await client.importIndex("TESTDB", { myindex: "acc", rows: [] });
    await client.importSortCodes("TESTDB", { myindex: "accsort", rows: [] });
    await client.importTransTypes("TESTDB", { rows: [] });
    await client.setTriggerUrl("TESTDB", { url: "https://x", table: "stock" });
    await client.deleteTriggerUrl("TESTDB", { url: "https://x", table: "stock" });
    await client.updateTriggerUrl("TESTDB", { url: "https://x", table: "stock", field: "url", value: "https://y" });
    await client.getTriggerUrl("TESTDB");
    await client.tokenCompanies();

    const paths = requests
      .filter((r) => !r.url.includes("/createSession/"))
      .map((r) => r.url.replace("https://lb1.wizcloud.co.il/", ""));
    expect(paths).toEqual([
      "jtransApi/tmpBatch",
      "jtransApi/chkBatch",
      "jtransApi/newBatch",
      "jtransApi/issueBatch",
      "invApi/createDoc",
      "invApi/getDoc",
      "invApi/issueDocument",
      "docsApi/createRecipt",
      "docsApi/createInvRecipt",
      "ExportDataApi/exportData",
      "BankPagesApi/importBankPage",
      "IndexApi/importIndex",
      "SortCodeApi/importSortCodes",
      "TransTypesApi/importTransTypes",
      "TriggersApi/setURL",
      "TriggersApi/deleteURL",
      "TriggersApi/updateURL",
      "TriggersApi/getURL",
      "CompanyListToTokenApi/TokenCompanies",
    ]);
  });

  it("uses the primary DB session for TokenCompanies", async () => {
    const { fetchImpl, requests } = makeFetch({});
    const client = makeClient(fetchImpl);
    await client.tokenCompanies();
    const session = requests[0];
    expect(session?.url).toContain(`/createSession/${API_TOKEN}/TESTDB`);
  });
});
