/**
 * portfolio.ts — local store of the companies accessible to the API token.
 *
 * The store is populated from `CompanyListToTokenApi/TokenCompanies` and
 * persisted as JSON at HASHAVSHVET_PORTFOLIO_PATH (default
 * ./hashavshevet-portfolio.json) with file mode 0600. File contents are never
 * logged.
 *
 * The DOCUMENTED TokenCompanies response (https://docs.wizcloud.co.il/docs/companies/)
 * is `{statusCode: 200, status: {errors: "OK", repdata: [...]}}` with rows
 * carrying Company_File_Name / Company_Name / Comp_Vatnum / Comp_LossNum —
 * validated strictly by parseDocumentedTokenCompanies().
 * normalizeCompanies() additionally tolerates the historical legacy aliases:
 *   - a bare array, or `{ companies: [...] }` / `{ Companies: [...] }` /
 *     `{ data: [...] }` / `{ rows: [...] }`;
 *   - per-company field names `name`/`Name`/`companyName`/`CompanyName`,
 *     `dbName`/`DBName`/`dbname`/`DbName`, `server`/`Server`/`apiServer`.
 * Bodies that CLAIM the documented envelope but violate it are rejected as
 * malformed — they never fall back to legacy parsing.
 */

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WizcloudClient } from "./wizcloud-client.js";

export interface Company {
  /** Display name, as returned by TokenCompanies. */
  name: string;
  /** WizCloud DBName used to mint sessions for this company. */
  dbName: string;
  /** API server for this company (defaults to the configured server). */
  server: string;
}

export interface Portfolio {
  companies: Company[];
  updatedAt: string;
}

export class PortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioError";
  }
}

export class PortfolioStore {
  readonly filePath: string;
  private readonly defaultServer: string;

  constructor(filePath: string, defaultServer: string) {
    this.filePath = filePath;
    this.defaultServer = defaultServer;
  }

  async load(): Promise<Portfolio | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (isMissingFileError(err)) return null;
      throw new PortfolioError(`Unable to read the portfolio file safely: ${errorMessage(err)}`);
    }
    // A file may have been created or modified outside this process. Reassert
    // the private mode before accepting any persisted company data.
    await ensurePrivateFileMode(this.filePath);
    try {
      const parsed = JSON.parse(raw) as Portfolio;
      if (!parsed || !Array.isArray(parsed.companies)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Persist the portfolio with mode 0600. Contents are never logged. */
  async save(portfolio: Portfolio): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(portfolio, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    // `mode` only applies when the file is created. Re-assert it on refresh so
    // a pre-existing portfolio cannot remain readable by other local users.
    await chmod(this.filePath, 0o600);
    await ensurePrivateFileMode(this.filePath);
  }

  /**
   * Re-call TokenCompanies and rewrite the store. Returns the new portfolio
   * plus a `validation` marker when — and only when — the fresh response
   * validated as the DOCUMENTED success envelope (which may carry ZERO
   * companies). Legacy-alias refreshes return the base shape. Rejections and
   * malformed envelopes throw FIXED typed messages and never overwrite the
   * existing cache.
   */
  async refresh(client: WizcloudClient): Promise<PortfolioRefreshResult> {
    const raw = await client.tokenCompanies();
    const documented = parseDocumentedTokenCompanies(raw, this.defaultServer);
    if (documented !== null) {
      if (documented.outcome === "ok") {
        const portfolio: Portfolio = {
          companies: documented.companies,
          updatedAt: new Date().toISOString(),
        };
        await this.save(portfolio);
        return { ...portfolio, validation: "documented-ok" };
      }
      if (documented.outcome === "rejected") {
        // FIXED messages only — provider text is never interpolated into
        // error messages or tool results.
        throw new PortfolioError(
          documented.reason === "permission-denied"
            ? "The company list request was denied permission for these credentials; the portfolio cache was left unchanged"
            : "The company list request reported a provider error; the portfolio cache was left unchanged",
        );
      }
      throw new PortfolioError(
        "The company list response claimed the documented envelope but was malformed; the portfolio cache was left unchanged",
      );
    }
    // Legacy (pre-documentation) alias shapes stay supported byte-identically.
    const portfolio: Portfolio = {
      companies: normalizeCompanies(raw, this.defaultServer),
      updatedAt: new Date().toISOString(),
    };
    if (portfolio.companies.length === 0) {
      // A bare [] is NOT the documented envelope and cannot prove a
      // successful zero — it keeps the historical shape failure.
      throw new PortfolioError(
        "TokenCompanies returned no companies — the response shape may have changed (see normalizeCompanies in src/portfolio.ts)",
      );
    }
    await this.save(portfolio);
    return portfolio;
  }

  /**
   * Exact-match resolution by company name or DBName. Returns null when there
   * is no match — callers must never guess.
   */
  resolve(portfolio: Portfolio, company: string): Company | null {
    const needle = company.trim();
    return (
      portfolio.companies.find((c) => c.name === needle || c.dbName === needle) ?? null
    );
  }

  /** Load the store; if absent, refresh it once from the API. */
  async loadOrRefresh(client: WizcloudClient): Promise<Portfolio> {
    const existing = await this.load();
    if (existing) return existing;
    return this.refresh(client);
  }
}

/**
 * Refresh result: the persisted base Portfolio plus an OPTIONAL validation
 * marker derived by OUR parser from the ACTUAL fresh documented envelope.
 * `validation` is present ONLY when the response validated as documented
 * success ("documented-ok"); legacy-alias refreshes return the plain
 * Portfolio shape (no marker) and cached reads can never attest one.
 */
export type PortfolioRefreshResult = Portfolio & { validation?: "documented-ok" };

/**
 * Outcome of validating a TokenCompanies response against the DOCUMENTED
 * envelope — https://docs.wizcloud.co.il/docs/companies/:
 * `{statusCode: 200, status: {errors: "OK", repdata: [rows]}}` with rows
 * carrying Company_File_Name / Company_Name / Comp_Vatnum / Comp_LossNum.
 *
 * - `ok` — exact documented success; `repdata` may legitimately be EMPTY.
 * - `rejected` — explicit provider non-success (non-"OK" own `errors`, or a
 *   statusCode other than 200). HTTP 200 alone is NOT success.
 * - `malformed` — the body CLAIMS the documented envelope (own `statusCode`
 *   or own `status`) but violates it. Never falls back to legacy parsing.
 */
export type DocumentedTokenCompanies =
  | { outcome: "ok"; companies: Company[] }
  | { outcome: "rejected"; reason: "permission-denied" | "provider-error" }
  | { outcome: "malformed" };

/**
 * Validate the DOCUMENTED TokenCompanies envelope strictly.
 * Claims are detected on the response's OWN properties only (inherited
 * metadata is not a claim). Returns null ONLY for bodies making no
 * documented claim at all — the legacy alias normalizer then applies.
 */
export function parseDocumentedTokenCompanies(
  raw: unknown,
  defaultServer: string,
): DocumentedTokenCompanies | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const claimsStatus = Object.hasOwn(record, "statusCode");
  const claimsState = Object.hasOwn(record, "status");
  if (!claimsStatus && !claimsState) return null;

  // statusCode: REQUIRED OWN property for every documented claim — a status
  // object alone is claimed-but-broken, never a successful validation.
  if (!claimsStatus) return { outcome: "malformed" };
  const code = record.statusCode;
  if (typeof code !== "number" || !Number.isInteger(code) || !Number.isFinite(code)) {
    return { outcome: "malformed" };
  }
  if (code !== 200) return { outcome: "rejected", reason: "provider-error" };

  // status: OWN object with OWN string `errors` literal "OK".
  if (!claimsState) return { outcome: "malformed" };
  const status = record.status;
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    return { outcome: "malformed" };
  }
  const statusRecord = status as Record<string, unknown>;
  if (!Object.hasOwn(statusRecord, "errors")) return { outcome: "malformed" };
  const errors = statusRecord.errors;
  if (typeof errors !== "string" || errors.length === 0) return { outcome: "malformed" };
  if (errors === "No Permission") return { outcome: "rejected", reason: "permission-denied" };
  if (errors !== "OK") return { outcome: "rejected", reason: "provider-error" };

  // repdata: OWN array of rows with usable OWN Company_File_Name identity.
  if (!Object.hasOwn(statusRecord, "repdata")) return { outcome: "malformed" };
  const repdata = statusRecord.repdata;
  if (!Array.isArray(repdata)) return { outcome: "malformed" };
  const companies: Company[] = [];
  for (const entry of repdata) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { outcome: "malformed" };
    }
    const row = entry as Record<string, unknown>;
    // DB identity: OWN, real, usable Company_File_Name only — inherited
    // values are not this row's identity, and a display name is never used.
    if (!Object.hasOwn(row, "Company_File_Name")) return { outcome: "malformed" };
    const raw = row.Company_File_Name;
    const file = typeof raw === "string" && raw.trim().length > 0 ? raw : null;
    if (!file) return { outcome: "malformed" };
    const name =
      typeof row.Company_Name === "string" && row.Company_Name.trim().length > 0
        ? row.Company_Name
        : file;
    companies.push({ name, dbName: file, server: defaultServer });
  }
  return { outcome: "ok", companies };
}

/** Normalize the (undocumented) TokenCompanies response into Company[]. */
export function normalizeCompanies(raw: unknown, defaultServer: string): Company[] {
  let list: unknown[] | null = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["companies", "Companies", "data", "rows", "Items"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        list = value;
        break;
      }
    }
  }
  if (!list) return [];

  const companies: Company[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = pickString(record, ["name", "Name", "companyName", "CompanyName"]);
    const dbName = pickString(record, ["dbName", "DBName", "dbname", "DbName", "db"]);
    if (!name && !dbName) continue;
    companies.push({
      name: name ?? (dbName as string),
      dbName: dbName ?? (name as string),
      server: pickString(record, ["server", "Server", "apiServer"]) ?? defaultServer,
    });
  }
  return companies;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Ensure a persisted portfolio is owner-only readable/writable. chmod is
 * available on supported Node platforms; verifying the resulting mode keeps
 * the loader fail-closed if the host cannot enforce the requested permission.
 */
async function ensurePrivateFileMode(filePath: string): Promise<void> {
  let current;
  try {
    current = await stat(filePath);
  } catch (err) {
    throw new PortfolioError(`Unable to inspect the portfolio file safely: ${errorMessage(err)}`);
  }

  if ((current.mode & 0o077) === 0) return;

  try {
    await chmod(filePath, 0o600);
  } catch (err) {
    throw new PortfolioError(`Portfolio file permissions could not be tightened: ${errorMessage(err)}`);
  }

  let tightened;
  try {
    tightened = await stat(filePath);
  } catch (err) {
    throw new PortfolioError(`Unable to verify portfolio file permissions: ${errorMessage(err)}`);
  }
  if ((tightened.mode & 0o077) !== 0) {
    throw new PortfolioError("Portfolio file permissions remain too broad; refusing to load it");
  }
}

function isMissingFileError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the standard "unknown company" error, listing known names. */
export function unknownCompanyError(company: string, portfolio: Portfolio): PortfolioError {
  const known = portfolio.companies.map((c) => `${c.name} (DBName: ${c.dbName})`);
  const listing = known.length > 0 ? known.join(", ") : "(none — run hashavshevet_companies refresh first)";
  return new PortfolioError(
    `Unknown company "${company}". Known companies: ${listing}. Use an exact company name or DBName.`,
  );
}
