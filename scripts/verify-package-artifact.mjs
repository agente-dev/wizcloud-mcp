#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// The CI build and notice check run immediately before this command. Ignore
// lifecycle scripts here so npm emits a machine-readable report without
// interleaving prepack/build logs; the real `npm pack` path still runs the
// package's prepack hook.
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

let reports;
try {
  reports = JSON.parse(result.stdout);
} catch (err) {
  throw new Error(`Could not parse npm pack report: ${err instanceof Error ? err.message : String(err)}`);
}

const files = reports.flatMap((report) => report.files ?? []).map((file) => file.path);
for (const required of ["dist/index.js", "THIRD_PARTY_NOTICES.md"]) {
  if (!files.includes(required)) {
    throw new Error(`npm package dry-run is missing ${required}`);
  }
}
console.log(`npm package dry-run includes ${files.length} files, including THIRD_PARTY_NOTICES.md`);
