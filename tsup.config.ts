import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  outDir: "dist",
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  external: ["@modelcontextprotocol/sdk", "zod"],
  noExternal: [/.*/],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
