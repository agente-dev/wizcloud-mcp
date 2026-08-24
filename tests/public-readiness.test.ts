import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatListeningMessage } from "../src/startup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readRootFile(name: string): Promise<string> {
  return readFile(join(root, name), "utf8");
}

describe("public repository readiness", () => {
  it("points API readers at the official current WizCloud documentation", async () => {
    const readme = await readRootFile("README.md");
    const client = await readRootFile("src/wizcloud-client.ts");

    expect(readme).toContain("https://docs.wizcloud.co.il/docs/rest-api/");
    expect(readme).toContain("Latest (2.0.0)");
    expect(client).toContain("https://docs.wizcloud.co.il/docs/rest-api/");
    expect(readme).not.toMatch(/swaggerhub\.com/i);
    expect(client).not.toMatch(/swaggerhub\.com/i);
  });

  it("includes generated third-party notices in the package allowlist", async () => {
    const packageJson = JSON.parse(await readRootFile("package.json")) as {
      files?: string[];
    };
    const notices = await readRootFile("THIRD_PARTY_NOTICES.md");

    expect(packageJson.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("@modelcontextprotocol/sdk");
    expect(notices).toContain("zod");
  });

  it("does not include the bootstrap database in startup diagnostics", () => {
    expect(formatListeningMessage("lb1.wizcloud.co.il")).toBe(
      "wizcloud-mcp: listening on stdio (server=lb1.wizcloud.co.il)",
    );
    expect(formatListeningMessage("lb1.wizcloud.co.il")).not.toContain("primaryDb");
  });

  it("records legal ownership and audit as explicit publication gates", async () => {
    const releasing = await readRootFile("RELEASING.md");
    const workflow = await readRootFile(".github/workflows/ci.yml");

    expect(releasing).toMatch(/authoritative.*owner|owner.*authoritative/i);
    expect(workflow).toContain("pnpm audit --prod --audit-level high");
    expect(workflow).not.toContain("--audit-level low");
  });
});
