/**
 * wizcloud-client.ts — HTTP layer for the WizCloud (Hashavshevet בענן) REST API.
 *
 * ALL endpoint paths, payload construction, and response parsing live in this
 * file. If dogfooding reveals a wrong path or payload shape, this is the only
 * file that should need to change.
 *
 * Schema sources (fetched 2026-07-25):
 * - Confirmed via the official Swagger: https://app.swaggerhub.com/apis-docs/Wizcloud/Api/1.0.0
 *   (registry: https://api.swaggerhub.com/apis/Wizcloud/Api/1.0.0)
 *   Confirmed request bodies: invApi/*, docsApi/*, jtransApi/*, IndexApi,
 *   SortCodeApi, TransTypesApi, BankPagesApi, ExportDataApi, TriggersApi.
 * - ASSUMPTIONS (not documented in the Swagger):
 *   1. createSession response: assumed JSON containing a `wizAuthToken` string
 *      field (docs say "Return wizAuthToken"). Parser also tolerates a bare
 *      string body or other single-string-field objects.
 *   2. TokenCompanies: no documented request/response schema. Called as a bare
 *      POST with an empty JSON body. Response normalization (array vs
 *      `{ companies: [...] }`, and per-company field names) lives in
 *      src/portfolio.ts.
 *   3. No response schemas are documented for ANY endpoint, so all responses
 *      are passed through as parsed JSON (or text) without validation.
 *
 * REDACTION: the API private key and session tokens are never logged and never
 * included in thrown error messages.
 */

/** Session tokens are minted for 24h by the server; re-mint after 23h. */
export const SESSION_TTL_MS = 23 * 60 * 60 * 1000;

export interface SessionEntry {
  wizAuthToken: string;
  mintedAt: number;
}

export interface WizcloudClientOptions {
  /** API server host, e.g. "lb1.wizcloud.co.il" (no scheme, no trailing slash). */
  server: string;
  /** WizcloudApiPrivateKey — the static API token. Never logged. */
  apiToken: string;
  /** DBName used to mint the bootstrap session. */
  primaryDb: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class WizcloudApiError extends Error {
  readonly status: number | null;
  readonly apiPath: string;
  /** True when the server rejected the session token (401 or auth-looking body). */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status: number | null; apiPath: string; isAuthError?: boolean }) {
    super(message);
    this.name = "WizcloudApiError";
    this.status = opts.status;
    this.apiPath = opts.apiPath;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

/**
 * Strip anything that could be a token from arbitrary text before it goes into
 * an error message or log line. The API key and session tokens are long
 * alphanumeric strings; we redact any such run defensively.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

export class WizcloudClient {
  private readonly server: string;
  private readonly apiToken: string;
  private readonly primaryDb: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Session cache: dbName → session entry. */
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(opts: WizcloudClientOptions) {
    this.server = opts.server.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.apiToken = opts.apiToken;
    this.primaryDb = opts.primaryDb;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Current session token for a company DB, minting or re-minting as needed. */
  async getSession(dbName: string): Promise<string> {
    const cached = this.sessions.get(dbName);
    if (cached && this.now() - cached.mintedAt < SESSION_TTL_MS) {
      return cached.wizAuthToken;
    }
    return this.mintSession(dbName);
  }

  private async mintSession(dbName: string): Promise<string> {
    // GET https://{server}/createSession/{WizcloudApiPrivateKey}/{WizcloudApiDBName}
    const url = `https://${this.server}/createSession/${encodeURIComponent(this.apiToken)}/${encodeURIComponent(dbName)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET" });
    } catch (err) {
      throw new WizcloudApiError(
        `createSession failed for DB "${dbName}": network error (${err instanceof Error ? err.message : String(err)})`,
        { status: null, apiPath: "createSession" },
      );
    }
    if (!res.ok) {
      throw new WizcloudApiError(
        `createSession failed for DB "${dbName}": HTTP ${res.status} ${this.safeBodySnippet(await this.safeText(res))}`,
        { status: res.status, apiPath: "createSession", isAuthError: res.status === 401 || res.status === 403 },
      );
    }
    const token = this.parseSessionToken(await this.safeText(res), dbName);
    this.sessions.set(dbName, { wizAuthToken: token, mintedAt: this.now() });
    return token;
  }

  /**
   * Parse the createSession response.
   * ASSUMPTION: body is JSON like `{ "wizAuthToken": "..." }` (possibly with
   * other fields). Also tolerated: a bare JSON string, or a plain-text token.
   */
  private parseSessionToken(body: string, dbName: string): string {
    const trimmed = body.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string" && parsed.length > 0) return parsed;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["wizAuthToken", "token", "authToken", "sessionToken"]) {
          const value = record[key];
          if (typeof value === "string" && value.length > 0) return value;
        }
        const stringValues = Object.values(record).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
        if (stringValues.length === 1 && stringValues[0]) return stringValues[0];
      }
    } catch {
      // Not JSON — fall through to plain-text handling.
    }
    if (trimmed.length > 0 && !trimmed.includes("\n")) return trimmed;
    throw new WizcloudApiError(
      `createSession for DB "${dbName}" returned an unparseable response (no token found)`,
      { status: null, apiPath: "createSession" },
    );
  }

  /**
   * POST https://{server}/{apiPath} with the session token as the
   * Authorization header. On an auth error, re-mints the session once and
   * retries once.
   */
  async call(dbName: string, apiPath: string, data?: unknown): Promise<unknown> {
    let token = await this.getSession(dbName);
    try {
      return await this.post(apiPath, token, data);
    } catch (err) {
      if (err instanceof WizcloudApiError && err.isAuthError) {
        // Session rejected — drop the cached entry, re-mint, retry once.
        this.sessions.delete(dbName);
        token = await this.mintSession(dbName);
        return this.post(apiPath, token, data);
      }
      throw err;
    }
  }

  private async post(apiPath: string, sessionToken: string, data: unknown): Promise<unknown> {
    const url = `https://${this.server}/${apiPath}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: sessionToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data ?? {}),
      });
    } catch (err) {
      throw new WizcloudApiError(
        `${apiPath} failed: network error (${err instanceof Error ? err.message : String(err)})`,
        { status: null, apiPath },
      );
    }

    const text = await this.safeText(res);
    if (!res.ok) {
      const snippet = this.safeBodySnippet(text, sessionToken);
      throw new WizcloudApiError(
        `${apiPath} failed: HTTP ${res.status}${snippet}`,
        { status: res.status, apiPath, isAuthError: res.status === 401 || res.status === 403 },
      );
    }
    // Some WizCloud endpoints signal auth failures with HTTP 200 + error body.
    if (looksLikeAuthError(text)) {
      throw new WizcloudApiError(`${apiPath} failed: session rejected by server`, {
        status: res.status,
        apiPath,
        isAuthError: true,
      });
    }
    return parseBody(text);
  }

  /** Body excerpt safe for error messages: truncated and token-redacted. */
  private safeBodySnippet(text: string, sessionToken?: string): string {
    const secrets = [this.apiToken, ...(sessionToken ? [sessionToken] : [])];
    const cleaned = redactSecrets(text, secrets).trim();
    if (!cleaned) return "";
    return `: ${cleaned.slice(0, 300)}`;
  }

  private async safeText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Endpoint wrappers — one per documented apiPath. Payload schemas below are
  // CONFIRMED from the Swagger unless marked ASSUMPTION.
  // ---------------------------------------------------------------------------

  /**
   * POST CompanyListToTokenApi/TokenCompanies — list companies the token can
   * access. ASSUMPTION: called with an empty JSON body (no request schema is
   * documented). Response normalization lives in src/portfolio.ts.
   */
  async tokenCompanies(): Promise<unknown> {
    // TokenCompanies authenticates with the token itself; use the bootstrap
    // (primary DB) session for the Authorization header.
    return this.call(this.primaryDb, "CompanyListToTokenApi/TokenCompanies", {});
  }

  /** POST jtransApi/tmpBatch — stage a journal-entry batch. Schema CONFIRMED. */
  async tmpBatch(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "jtransApi/tmpBatch", data);
  }

  /** POST jtransApi/chkBatch — check a staged batch. Body: { batchNo }. CONFIRMED. */
  async chkBatch(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "jtransApi/chkBatch", data);
  }

  /** POST jtransApi/newBatch — finalize a checked batch. No documented body. CONFIRMED. */
  async newBatch(dbName: string, data?: unknown): Promise<unknown> {
    return this.call(dbName, "jtransApi/newBatch", data);
  }

  /** POST jtransApi/issueBatch — issue a finalized batch. Body: { batchNo }. CONFIRMED. */
  async issueBatch(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "jtransApi/issueBatch", data);
  }

  /** POST invApi/createDoc — create a document (invoice, order, …). CONFIRMED. */
  async createDoc(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "invApi/createDoc", data);
  }

  /** POST invApi/getDoc — fetch a document. Body: { stockID }. CONFIRMED. */
  async getDoc(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "invApi/getDoc", data);
  }

  // NOTE: invApi/delDocument is deliberately NOT exposed.

  /** POST invApi/issueDocument — issue a created document. Body: { stockID }. CONFIRMED. */
  async issueDocument(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "invApi/issueDocument", data);
  }

  /** POST docsApi/createRecipt [sic — the API's spelling] — create a receipt. CONFIRMED. */
  async createReceipt(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "docsApi/createRecipt", data);
  }

  /** POST docsApi/createInvRecipt [sic] — create an invoice-receipt. CONFIRMED. */
  async createInvoiceReceipt(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "docsApi/createInvRecipt", data);
  }

  /**
   * POST ExportDataApi/exportData — run a report export.
   * Body: { datafile: string, parameters: string }. CONFIRMED (Swagger);
   * the valid `datafile` report identifiers are not enumerated — passthrough.
   */
  async exportData(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "ExportDataApi/exportData", data);
  }

  /** POST BankPagesApi/importBankPage — import bank statement rows. CONFIRMED. */
  async importBankPage(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "BankPagesApi/importBankPage", data);
  }

  /** POST IndexApi/importIndex — import account/item records. CONFIRMED. */
  async importIndex(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "IndexApi/importIndex", data);
  }

  /** POST SortCodeApi/importSortCodes — import sort codes. CONFIRMED. */
  async importSortCodes(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "SortCodeApi/importSortCodes", data);
  }

  /** POST TransTypesApi/importTransTypes — import transaction types. CONFIRMED. */
  async importTransTypes(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "TransTypesApi/importTransTypes", data);
  }

  /** POST TriggersApi/setURL — register a webhook trigger. Body: TriggerAddress. CONFIRMED. */
  async setTriggerUrl(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "TriggersApi/setURL", data);
  }

  /** POST TriggersApi/deleteURL — remove a webhook trigger. Body: TriggerAddress. CONFIRMED. */
  async deleteTriggerUrl(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "TriggersApi/deleteURL", data);
  }

  /** POST TriggersApi/updateURL — update a trigger's url/table field. CONFIRMED. */
  async updateTriggerUrl(dbName: string, data: unknown): Promise<unknown> {
    return this.call(dbName, "TriggersApi/updateURL", data);
  }

  /** POST TriggersApi/getURL — list registered triggers. No documented body. CONFIRMED. */
  async getTriggerUrl(dbName: string, data?: unknown): Promise<unknown> {
    return this.call(dbName, "TriggersApi/getURL", data);
  }
}

/** Heuristic for HTTP-200 auth failures (session expiry mid-day). */
function looksLikeAuthError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("invalid token") ||
    lower.includes("invalid wizauthtoken") ||
    lower.includes("session expired") ||
    lower.includes("unauthorized")
  );
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
