import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PortfolioStore,
  normalizeCompanies,
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
