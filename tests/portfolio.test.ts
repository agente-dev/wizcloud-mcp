import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PortfolioError,
  PortfolioStore,
  normalizeCompanies,
  parseDocumentedTokenCompanies,
  unknownCompanyError,
  type Portfolio,
} from "../src/portfolio.js";
import { WizcloudClient } from "../src/wizcloud-client.js";

const PORTFOLIO: Portfolio = {
  companies: [
    { name: "Acme Ltd", dbName: "ACMEDB", server: "lb1.wizcloud.co.il" },
    { name: "Beta ביטא", dbName: "BETADB", server: "lb1.wizcloud.co.il" },
  ],
  updatedAt: "2026-07-25T00:00:00.000Z",
};

let dir: string;
let store: PortfolioStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wizcloud-portfolio-"));
  store = new PortfolioStore(join(dir, "portfolio.json"), "lb1.wizcloud.co.il");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PortfolioStore", () => {
  it("returns null when the file is absent", async () => {
    expect(await store.load()).toBeNull();
  });

  it("saves with mode 0600 and loads back", async () => {
    await store.save(PORTFOLIO);
    const mode = (await stat(store.filePath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await store.load()).toEqual(PORTFOLIO);
  });

  it("tightens permissions again when refreshing an existing file", async () => {
    await store.save(PORTFOLIO);
    await chmod(store.filePath, 0o644);

    await store.save({ ...PORTFOLIO, updatedAt: "2026-07-26T00:00:00.000Z" });

    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("tightens permissions before returning an existing portfolio", async () => {
    await writeFile(store.filePath, JSON.stringify(PORTFOLIO), { mode: 0o644 });
    await chmod(store.filePath, 0o644);

    expect(await store.load()).toEqual(PORTFOLIO);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("refresh calls TokenCompanies, normalizes, and rewrites the store", async () => {
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "test-session-xxx" }), { status: 200 });
      }
      expect(url).toContain("CompanyListToTokenApi/TokenCompanies");
      return new Response(
        JSON.stringify({
          companies: [
            { name: "Gamma Inc", dbName: "GAMMADB", server: "lb2.wizcloud.co.il" },
            { Name: "Delta", DBName: "DELTADB" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl,
    });

    const portfolio = await store.refresh(client);
    expect(portfolio.companies).toEqual([
      { name: "Gamma Inc", dbName: "GAMMADB", server: "lb2.wizcloud.co.il" },
      { name: "Delta", dbName: "DELTADB", server: "lb1.wizcloud.co.il" },
    ]);
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8")) as Portfolio;
    expect(onDisk.companies).toEqual(portfolio.companies);
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  it("loadOrRefresh refreshes once when no store exists, then reuses it", async () => {
    let tokenCompaniesCalls = 0;
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "test-session-xxx" }), { status: 200 });
      }
      tokenCompaniesCalls += 1;
      return new Response(JSON.stringify([{ name: "Acme Ltd", dbName: "ACMEDB" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl,
    });

    const first = await store.loadOrRefresh(client);
    const second = await store.loadOrRefresh(client);
    expect(first.companies[0]?.name).toBe("Acme Ltd");
    expect(second).toEqual(first);
    expect(tokenCompaniesCalls).toBe(1);
  });
});

describe("company resolution", () => {
  it("resolves by exact company name", () => {
    expect(store.resolve(PORTFOLIO, "Acme Ltd")?.dbName).toBe("ACMEDB");
  });

  it("resolves by DBName", () => {
    expect(store.resolve(PORTFOLIO, "BETADB")?.name).toBe("Beta ביטא");
  });

  it("returns null for unknown companies (never guesses)", () => {
    expect(store.resolve(PORTFOLIO, "acme")).toBeNull();
    expect(store.resolve(PORTFOLIO, "Acme")).toBeNull();
    expect(store.resolve(PORTFOLIO, "Nope Corp")).toBeNull();
  });

  it("unknown-company error lists known names", () => {
    const err = unknownCompanyError("Nope Corp", PORTFOLIO);
    expect(err.message).toContain("Acme Ltd");
    expect(err.message).toContain("Beta ביטא");
    expect(err.message).toContain("ACMEDB");
    expect(err.message).toContain("Nope Corp");
  });
});


describe("parseDocumentedTokenCompanies (documented envelope)", () => {
  it("maps the documented nested repdata fields (name/dbName/server only)", () => {
    const out = parseDocumentedTokenCompanies(
      {
        statusCode: 200,
        status: {
          errors: "OK",
          repdata: [
            { Company_File_Name: "wizdb555n1", Company_Name: "חברה לדוגמה 1", Comp_Vatnum: "123456789", Comp_LossNum: null },
            { Company_File_Name: "wizdb555n2", Company_Name: "חברה לדוגמה 2" },
          ],
        },
      },
      "lb1.wizcloud.co.il",
    );
    expect(out).toEqual({
      outcome: "ok",
      companies: [
        { name: "חברה לדוגמה 1", dbName: "wizdb555n1", server: "lb1.wizcloud.co.il" },
        { name: "חברה לדוגמה 2", dbName: "wizdb555n2", server: "lb1.wizcloud.co.il" },
      ],
    });
  });

  it("treats a documented successful EMPTY repdata as ok", () => {
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: "OK", repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "ok", companies: [] });
  });

  it("rejects No Permission and other non-OK errors despite HTTP 200", () => {
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: "No Permission", repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "rejected", reason: "permission-denied" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: "Error: Data not found", repdata: null } }, "lb1"),
    ).toEqual({ outcome: "rejected", reason: "provider-error" });
  });

  it("rejects non-200 statusCode (201/500) and non-finite/non-integer codes as claimed-envelope failures", () => {
    expect(
      parseDocumentedTokenCompanies({ statusCode: 500, status: { errors: "Error: boom" } }, "lb1"),
    ).toEqual({ outcome: "rejected", reason: "provider-error" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 201, status: { errors: "OK", repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "rejected", reason: "provider-error" });
    expect(parseDocumentedTokenCompanies({ statusCode: NaN }, "lb1")).toEqual({ outcome: "malformed" });
    expect(parseDocumentedTokenCompanies({ statusCode: 200.5 }, "lb1")).toEqual({ outcome: "malformed" });
    expect(parseDocumentedTokenCompanies({ statusCode: "200" }, "lb1")).toEqual({ outcome: "malformed" });
  });

  it("treats a claimed-but-broken envelope as malformed, never legacy fallback or success", () => {
    expect(parseDocumentedTokenCompanies({ statusCode: 200 }, "lb1")).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: null }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: "OK" }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: [] }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: null, repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: 5, repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: "OK", repdata: null } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies({ statusCode: 200, status: { errors: "OK", repdata: {} } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
    // A valid legacy array under a claimed status is NOT a legacy fallback.
    expect(
      parseDocumentedTokenCompanies(
        { statusCode: 200, status: { errors: "OK" }, companies: [{ name: "A", dbName: "ADB" }] },
        "lb1",
      ),
    ).toEqual({ outcome: "malformed" });
    // Rows: no Company_File_Name / whitespace-only — never a guessed DB.
    expect(
      parseDocumentedTokenCompanies(
        { statusCode: 200, status: { errors: "OK", repdata: [{ Company_Name: "Only Display" }] } },
        "lb1",
      ),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies(
        { statusCode: 200, status: { errors: "OK", repdata: [{ Company_File_Name: "   ", Company_Name: "Blank" }] } },
        "lb1",
      ),
    ).toEqual({ outcome: "malformed" });
    expect(
      parseDocumentedTokenCompanies(
        { statusCode: 200, status: { errors: "OK", repdata: ["not-an-object"] } },
        "lb1",
      ),
    ).toEqual({ outcome: "malformed" });
  });

  it("REQUIRES an OWN statusCode even when status alone is present (Root counterexample A)", () => {
    // {status:{errors:"OK",repdata:[]}} WITHOUT statusCode must NOT validate
    // as documented success — the documented envelope always carries
    // statusCode 200. Expected: claimed-but-broken => malformed.
    expect(
      parseDocumentedTokenCompanies({ status: { errors: "OK", repdata: [] } }, "lb1"),
    ).toEqual({ outcome: "malformed" });
  });

  it("REQUIRES the native DB identity to be an OWN Company_File_Name (Root counterexample B)", () => {
    // A row whose Company_File_Name exists only on the PROTOTYPE chain is
    // not an own usable identity — never a successful company.
    const inheritedRow = Object.create({ Company_File_Name: "INHERITED_DB" });
    expect(
      parseDocumentedTokenCompanies(
        { statusCode: 200, status: { errors: "OK", repdata: [inheritedRow] } },
        "lb1",
      ),
    ).toEqual({ outcome: "malformed" });
  });

  it("returns null only when the body makes no documented claim (legacy fallback applies)", () => {
    expect(parseDocumentedTokenCompanies([{ name: "A", dbName: "ADB" }], "lb1")).toBeNull();
    expect(parseDocumentedTokenCompanies({ companies: [] }, "lb1")).toBeNull();
    expect(parseDocumentedTokenCompanies("garbage", "lb1")).toBeNull();
    expect(parseDocumentedTokenCompanies(null, "lb1")).toBeNull();
    // Inherited-only metadata (not own properties) is NOT a claim.
    expect(parseDocumentedTokenCompanies(Object.create({ statusCode: 200 }), "lb1")).toBeNull();
  });
});

describe("PortfolioStore.refresh against the documented envelope", () => {

  it("PRRT_Su: persists the TRIMMED native DB identifier so padded Company_File_Name resolves and requests the clean DB", async () => {
    const client = documentedClient({
      statusCode: 200,
      status: { errors: "OK", repdata: [{ Company_File_Name: "  PADDED-DB  ", Company_Name: "Padded Co" }] },
    });
    const refreshed = await store.refresh(client);
    // Padded raw must NOT be persisted; trimmed identifier is the identity.
    expect(refreshed.companies).toEqual([
      { name: "Padded Co", dbName: "PADDED-DB", server: "lb1.wizcloud.co.il" },
    ]);
    // resolve() trims the needle; the CLEAN identifier must now match.
    const loaded = await store.load();
    expect(store.resolve(loaded!, "PADDED-DB")?.dbName).toBe("PADDED-DB");
    expect(store.resolve(loaded!, "  PADDED-DB  ")?.dbName).toBe("PADDED-DB");
    expect(store.resolve(loaded!, "Padded Co")?.dbName).toBe("PADDED-DB");
    // Fallback display name (no Company_Name) must also be the trimmed DB.
    const fallback = documentedClient({
      statusCode: 200,
      status: { errors: "OK", repdata: [{ Company_File_Name: "\tSTRIP-DB\n" }] },
    });
    const r2 = await store.refresh(fallback);
    expect(r2.companies).toEqual([
      { name: "STRIP-DB", dbName: "STRIP-DB", server: "lb1.wizcloud.co.il" },
    ]);
  });

  it("PRRT_Su: whitespace-only Company_File_Name stays malformed with cache unchanged", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const client = documentedClient({
      statusCode: 200,
      status: { errors: "OK", repdata: [{ Company_File_Name: "   ", Company_Name: "WS" }] },
    });
    await expect(store.refresh(client)).rejects.toThrow(/malformed/);
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  it("PRRT_S2: 401/403 acquisition errors translate to a FIXED auth message; provider body never leaks", async () => {
    for (const status of [401, 403]) {
      const client = httpErrorClient(status, "PRIVATE-TOKEN-LEAK-XYZ");
      await expect(store.refresh(client)).rejects.toThrow(
        /company list request could not be authenticated/,
      );
      await expect(store.refresh(client)).rejects.not.toThrow(/PRIVATE-TOKEN-LEAK-XYZ/);
    }
  });

  it("PRRT_S2: 500 acquisition errors translate to a FIXED provider-failure message", async () => {
    const client = httpErrorClient(500, "PRIVATE-STACK-TRACE-ABC");
    const err = (await store.refresh(client).catch((e: unknown) => e)) as PortfolioError;
    expect(err).toBeInstanceOf(PortfolioError);
    expect(err.message).toMatch(/company list request failed at the provider/);
    expect(err.message).not.toContain("PRIVATE-STACK-TRACE-ABC");
  });

  it("PRRT_S2: network/bootstrap failures translate to a FIXED connectivity message", async () => {
    const client = networkErrorClient(new Error("getaddrinfo ENOTFOUND private-host.internal"));
    const err = (await store.refresh(client).catch((e: unknown) => e)) as PortfolioError;
    expect(err).toBeInstanceOf(PortfolioError);
    expect(err.message).toMatch(/company list request could not reach the server/);
    expect(err.message).not.toContain("private-host.internal");
  });

  it("PRRT_S2: acquisition failures never overwrite the existing cache", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const modeBefore = (await stat(store.filePath)).mode & 0o777;
    for (const client of [
      httpErrorClient(500, "SECRET-1"),
      httpErrorClient(401, "SECRET-2"),
      networkErrorClient(new Error("ECONNREFUSED")),
    ]) {
      await expect(store.refresh(client)).rejects.toThrow(PortfolioError);
    }
    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect((await stat(store.filePath)).mode & 0o777).toBe(modeBefore);
  });

  function documentedFetch(body: unknown): typeof fetch {
    return (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "documented-session-xxx" }), { status: 200 });
      }
      expect(url).toContain("CompanyListToTokenApi/TokenCompanies");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  }
  // Real fetch-injected client whose TokenCompanies responds with an HTTP error
  // carrying a PRIVATE provider payload — the WizcloudClient.post() throw path.
  function httpErrorClient(status: number, privateBody: string): WizcloudClient {
    const fetchImpl = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.includes("/createSession/")) {
        return new Response(JSON.stringify({ wizAuthToken: "session-xxx" }), { status: 200 });
      }
      return new Response(privateBody, { status, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    return new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl,
    });
  }

  // Real client whose fetch REJECTS (network/bootstrap failure).
  function networkErrorClient(cause: Error): WizcloudClient {
    const fetchImpl = (async () => {
      throw cause;
    }) as unknown as typeof fetch;
    return new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl,
    });
  }

  function documentedClient(body: unknown): WizcloudClient {
    return new WizcloudClient({
      server: "lb1.wizcloud.co.il",
      apiToken: "test-token-xxx",
      primaryDb: "TESTDB",
      fetchImpl: documentedFetch(body),
    });
  }

  it("persists a documented multi-company refresh with mode 0600 and derives documented-ok", async () => {
    const client = documentedClient({
      statusCode: 200,
      status: {
        errors: "OK",
        repdata: [
          { Company_File_Name: "wizdb1", Company_Name: "One" },
          { Company_File_Name: "wizdb2", Company_Name: "Two" },
        ],
      },
    });
    const result = await store.refresh(client);
    expect(result.companies).toEqual([
      { name: "One", dbName: "wizdb1", server: "lb1.wizcloud.co.il" },
      { name: "Two", dbName: "wizdb2", server: "lb1.wizcloud.co.il" },
    ]);
    expect(result.validation).toBe("documented-ok");
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8")) as Portfolio;
    expect(onDisk.companies).toEqual(result.companies);
  });

  it("persists a documented successful EMPTY company set truthfully", async () => {
    const client = documentedClient({ statusCode: 200, status: { errors: "OK", repdata: [] } });
    const result = await store.refresh(client);
    expect(result.companies).toEqual([]);
    expect(result.validation).toBe("documented-ok");
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8")) as Portfolio;
    expect(onDisk.companies).toEqual([]);
  });

  it("a documented No Permission rejection uses fixed text and leaves the cache unchanged", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const client = documentedClient({
      statusCode: 200,
      status: { errors: "No Permission", repdata: [] },
    });
    await expect(store.refresh(client)).rejects.toThrow(/denied permission/);
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  it("an unknown provider error string never leaks into the thrown message and leaves the cache unchanged", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const client = documentedClient({
      statusCode: 200,
      status: { errors: "Error: PRIVATE_SENTINEL_DO_NOT_LEAK", repdata: [] },
    });
    let thrown = "";
    await expect(
      store.refresh(client).catch((err: Error) => {
        thrown = err.message;
        throw err;
      }),
    ).rejects.toThrow(/provider error/);
    expect(thrown).not.toContain("PRIVATE_SENTINEL_DO_NOT_LEAK");
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  it("a malformed documented envelope is a fixed error and leaves the cache unchanged", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const client = documentedClient({ statusCode: 200, status: { errors: "OK" } });
    await expect(store.refresh(client)).rejects.toThrow(/malformed/);
    expect(await readFile(store.filePath, "utf8")).toBe(before);
  });

  it("never promotes a display name to dbName and never persists on malformed rows", async () => {
    const client = documentedClient({
      statusCode: 200,
      status: { errors: "OK", repdata: [{ Company_Name: "Only Display" }] },
    });
    await expect(store.refresh(client)).rejects.toThrow(/malformed/);
    await expect(stat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the historical shape failure for an ambiguous legacy empty body", async () => {
    const client = documentedClient([]);
    await expect(store.refresh(client)).rejects.toThrow(/no companies/);
  });

  it("a missing statusCode through the REAL client is a fixed malformed error with cache bytes and mode unchanged", async () => {
    await store.save(PORTFOLIO);
    const before = await readFile(store.filePath, "utf8");
    const modeBefore = (await stat(store.filePath)).mode & 0o777;
    const client = documentedClient({ status: { errors: "OK", repdata: [] } });
    await expect(store.refresh(client)).rejects.toThrow(
      /claimed the documented envelope but was malformed/,
    );
    expect(await readFile(store.filePath, "utf8")).toBe(before);
    expect((await stat(store.filePath)).mode & 0o777).toBe(modeBefore);
    expect(modeBefore).toBe(0o600);
  });
});

describe("normalizeCompanies", () => {
  it("accepts a bare array", () => {
    expect(normalizeCompanies([{ name: "A", dbName: "ADB" }], "s")).toEqual([
      { name: "A", dbName: "ADB", server: "s" },
    ]);
  });

  it("accepts wrapped shapes and alternate field names", () => {
    const out = normalizeCompanies(
      { rows: [{ CompanyName: "C", DBName: "CDB", Server: "lb9" }] },
      "lb1",
    );
    expect(out).toEqual([{ name: "C", dbName: "CDB", server: "lb9" }]);
  });

  it("falls back to default server and returns [] for junk", () => {
    expect(normalizeCompanies({ nope: 1 }, "s")).toEqual([]);
    expect(normalizeCompanies("garbage", "s")).toEqual([]);
  });
});
