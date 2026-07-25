/**
 * portfolio.ts — local store of the companies accessible to the API token.
 *
 * The store is populated from `CompanyListToTokenApi/TokenCompanies` and
 * persisted as JSON at HASHAVSHVET_PORTFOLIO_PATH (default
 * ./hashavshevet-portfolio.json) with file mode 0600. File contents are never
 * logged.
 *
 * ASSUMPTION (not documented in the Swagger): the TokenCompanies response
 * shape. normalizeCompanies() tolerates:
 *   - a bare array, or `{ companies: [...] }` / `{ Companies: [...] }` /
 *     `{ data: [...] }` / `{ rows: [...] }`;
 *   - per-company field names `name`/`Name`/`companyName`/`CompanyName`,
 *     `dbName`/`DBName`/`dbname`/`DbName`, `server`/`Server`/`apiServer`.
 * If dogfooding shows the real shape differs, fix normalizeCompanies() only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    } catch {
      return null;
    }
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
  }

  /** Re-call TokenCompanies and rewrite the store. Returns the new portfolio. */
  async refresh(client: WizcloudClient): Promise<Portfolio> {
    const raw = await client.tokenCompanies();
    const portfolio: Portfolio = {
      companies: normalizeCompanies(raw, this.defaultServer),
      updatedAt: new Date().toISOString(),
    };
    if (portfolio.companies.length === 0) {
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

/** Build the standard "unknown company" error, listing known names. */
export function unknownCompanyError(company: string, portfolio: Portfolio): PortfolioError {
  const known = portfolio.companies.map((c) => `${c.name} (DBName: ${c.dbName})`);
  const listing = known.length > 0 ? known.join(", ") : "(none — run hashavshevet_companies refresh first)";
  return new PortfolioError(
    `Unknown company "${company}". Known companies: ${listing}. Use an exact company name or DBName.`,
  );
}
