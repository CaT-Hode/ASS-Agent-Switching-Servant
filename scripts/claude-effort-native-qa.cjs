// Read-only recognition check against the installed desktop's pure identifier
// normalizer and built-in metadata. Does not launch, patch or reload Claude.
const fs = require("node:fs"), vm = require("node:vm"), assert = require("node:assert/strict");
const { claudeModels } = require("../core/claude-models.cjs");
const archive = process.argv[2];
if (!archive || !require("node:path").isAbsolute(archive)) throw Error("Pass the absolute installed Claude app.asar path");
const source = fs.readFileSync(archive).toString("utf8");
const start = source.indexOf("function nIt(e){"), end = source.indexOf("function rIt(", start);
const tableStart = source.indexOf("czt={\"claude-haiku-"), tableEnd = source.indexOf(",lzt=", tableStart);
if (start < 0 || end <= start || end - start > 2000 || tableStart < 0 || tableEnd <= tableStart || tableEnd - tableStart > 10000)
  throw Error("Installed recognition implementation changed; no fallback assumptions");
const native = vm.runInNewContext(`${source.slice(start, end)}; ({ normalize: nIt, table: (${source.slice(tableStart + 4, tableEnd)}) })`, {}, { timeout: 100 });
const reports = [];
for (const model of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-5"]) {
  const providers = ["a", "b"].map(id => ({ id, name: id, enabled: true, apiKey: "synthetic-key", models: [{ model, enabled: true, wireApi: "anthropic" }] }));
  const rows = claudeModels(providers);
  assert.notEqual(rows[0].discoveryId, rows[1].discoveryId);
  for (const row of rows) {
    const normalized = native.normalize(row.discoveryId);
    assert.equal(normalized, model);
    assert.ok(native.table[normalized]?.effortLevels?.length);
  }
  reports.push({ model, nativeEffortLevels: native.table[model].effortLevels, distinctRoutes: true });
}
console.log(JSON.stringify({ checked: reports, desktopUiTested: false, userConfigModified: false }, null, 2));
