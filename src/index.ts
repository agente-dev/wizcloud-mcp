/**
 * index.ts — wizcloud-mcp stdio server entrypoint.
 *
 * Required env vars:
 *   HASHAVSHVET_API_SERVER   e.g. lb1.wizcloud.co.il
 *   HASHAVSHVET_API_TOKEN    WizcloudApiPrivateKey
 *   HASHAVSHVET_PRIMARY_DB   DBName used to mint the bootstrap session
 * Optional:
 *   HASHAVSHVET_PORTFOLIO_PATH  default ./hashavshevet-portfolio.json
 *
 * Secrets are referenced only via env vars and are never logged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WizcloudClient } from "./wizcloud-client.js";
import { PortfolioStore, type Company } from "./portfolio.js";
import { registerTools } from "./tools.js";
import { formatListeningMessage } from "./startup.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Never print the value of any secret — only the missing var's name.
    console.error(`wizcloud-mcp: missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const server = requireEnv("HASHAVSHVET_API_SERVER").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const apiToken = requireEnv("HASHAVSHVET_API_TOKEN");
  const primaryDb = requireEnv("HASHAVSHVET_PRIMARY_DB");
  const portfolioPath = process.env.HASHAVSHVET_PORTFOLIO_PATH ?? "./hashavshevet-portfolio.json";

  const defaultClient = new WizcloudClient({ server, apiToken, primaryDb });
  const portfolio = new PortfolioStore(portfolioPath, server);

  // Per-server client cache: companies may live on different WizCloud servers.
  const clientsByServer = new Map<string, WizcloudClient>([[server, defaultClient]]);
  const clientFor = (company: Company): WizcloudClient => {
    const host = company.server.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    let client = clientsByServer.get(host);
    if (!client) {
      client = new WizcloudClient({ server: host, apiToken, primaryDb });
      clientsByServer.set(host, client);
    }
    return client;
  };

  const mcp = new McpServer({
    name: "wizcloud-mcp",
    version: "0.1.0",
  });
  registerTools(mcp, { clientFor, defaultClient, portfolio });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(formatListeningMessage(server));
}

main().catch((err) => {
  console.error(`wizcloud-mcp: fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
