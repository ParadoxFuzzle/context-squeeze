import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CONFIG_JSON_SCHEMA } from "../config.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8")) as Record<string, unknown>;

test("package and manifest versions match", () => {
  assert.equal(pkg.version, manifest.version);
});

test("manifest declares the context-engine kind", () => {
  assert.equal(manifest.kind, "context-engine");
});

test("runtime and manifest config schemas stay aligned", () => {
  assert.deepEqual(manifest.configSchema, CONFIG_JSON_SCHEMA);
});

test("typebox is a runtime dependency", () => {
  const dependencies = pkg.dependencies as Record<string, string> | undefined;
  assert.ok(dependencies?.typebox, "typebox must be in dependencies");
});

test("license and package files are present", () => {
  assert.equal(pkg.license, "MIT");
  assert.ok(existsSync("LICENSE"));
  assert.ok(existsSync("dist/index.js"));
  assert.ok(existsSync("openclaw.plugin.json"));
});
