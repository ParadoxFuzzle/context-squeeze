import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("openclaw.plugin.json", "utf8"));
const entry = (await import("../dist/index.js")).default;

assert.equal(entry.id, manifest.id);
assert.equal(entry.name, manifest.name);
assert.equal(pkg.version, manifest.version);
assert.equal(manifest.kind, "context-engine");
assert.equal(typeof entry.register, "function");

const engines = [];
const tools = [];
const api = {
  pluginConfig: {},
  logger: { info() {}, debug() {}, warn() {} },
  registerContextEngine(id, factory) {
    engines.push({ id, factory });
  },
  registerTool(tool, options) {
    tools.push({ tool, options });
  },
};

entry.register(api);

assert.equal(engines.length, 1);
assert.equal(engines[0].id, "context-squeeze");
assert.equal(tools.length, 1);
assert.equal(tools[0].tool.name, "context-squeeze-stats");
assert.equal(tools[0].options.name, "context-squeeze-stats");
assert.equal(tools[0].options.workspaceAccess, false);

const engine = await engines[0].factory({});
assert.equal(engine.info.id, "context-squeeze");
assert.equal(engine.info.version, pkg.version);
assert.equal(engine.info.ownsCompaction, false);
assert.equal(typeof engine.assemble, "function");
assert.equal(typeof engine.compact, "function");
assert.equal(typeof engine.commitTurn, "function");

console.log(`Plugin ${manifest.id}@${manifest.version} entry is valid.`);
