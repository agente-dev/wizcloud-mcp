#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "THIRD_PARTY_NOTICES.md");
const checkOnly = process.argv.includes("--check");

function productionTree() {
  // A numeric depth keeps pnpm's JSON traversal fully recursive across the
  // supported pnpm versions (some versions treat `Infinity` as depth zero).
  const result = spawnSync("pnpm", ["list", "--prod", "--depth", "100", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pnpm list failed: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Could not parse pnpm dependency graph: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function collectPackages(tree) {
  const packages = new Map();
  const visit = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (!dependency?.version || !dependency?.path) continue;
      const key = `${name}@${dependency.version}`;
      if (packages.has(key)) continue;
      packages.set(key, { ...dependency, name, version: dependency.version });
      visit(dependency.dependencies);
    }
  };
  for (const project of tree) visit(project.dependencies);
  return [...packages.values()].sort((a, b) => {
    const left = `${a.name}@${a.version}`;
    const right = `${b.name}@${b.version}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

async function packageDetails(dependency) {
  const packageJson = JSON.parse(await readFile(join(dependency.path, "package.json"), "utf8"));
  const license = packageJson.license
    ?? (Array.isArray(packageJson.licenses)
      ? packageJson.licenses.map((entry) => entry.type ?? entry.name).filter(Boolean).join(", ")
      : "SEE LICENSE FILE");
  const repository = typeof packageJson.repository === "string"
    ? packageJson.repository
    : packageJson.repository?.url ?? packageJson.homepage ?? "(not declared)";
  let licenseText = null;
  try {
    const entries = await readdir(dependency.path, { withFileTypes: true });
    const licenseFile = entries.find(
      (entry) => entry.isFile() && /^(license|licence|copying)(\.|$)/i.test(entry.name),
    );
    if (licenseFile) {
      licenseText = (await readFile(join(dependency.path, licenseFile.name), "utf8"))
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "");
    }
  } catch {
    // The package metadata remains useful even when a package omits its text file.
  }
  return {
    name: packageJson.name ?? dependency.name,
    version: packageJson.version ?? dependency.version,
    license: String(license),
    repository: String(repository).replace(/^git\+/, ""),
    licenseText: licenseText?.trim() ?? null,
  };
}

async function render() {
  const projects = productionTree();
  const details = [];
  for (const dependency of collectPackages(projects)) details.push(await packageDetails(dependency));

  const lines = [
    "# Third-party notices",
    "",
    "> This file is generated from the production dependency graph by `pnpm generate-third-party-notices`.",
    "> It covers the dependencies bundled into the Hashavshevet MCP distribution. Do not edit it by hand.",
    "",
  ];
  for (const entry of details) {
    lines.push(`## ${entry.name}@${entry.version}`, "", `- License: ${entry.license}`, `- Source: ${entry.repository}`, "");
    if (entry.licenseText) lines.push("```text", entry.licenseText, "```", "");
    else lines.push("License text was not included in the installed package; see the source link above.", "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

const rendered = await render();
if (checkOnly) {
  let existing;
  try {
    existing = await readFile(outputPath, "utf8");
  } catch {
    throw new Error("THIRD_PARTY_NOTICES.md is missing; run pnpm generate-third-party-notices");
  }
  if (existing !== rendered) {
    throw new Error("THIRD_PARTY_NOTICES.md is stale; run pnpm generate-third-party-notices");
  }
} else {
  await writeFile(outputPath, rendered, "utf8");
}
