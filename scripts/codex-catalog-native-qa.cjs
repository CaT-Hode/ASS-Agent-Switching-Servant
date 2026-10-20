// Installed CLI parsers only. Never starts an MCP server, logs in, downloads a
// CLI, performs inference, or changes a real Codex profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process'), assert = require('node:assert/strict');
const TOML = require('@iarna/toml'), { makeCatalog } = require('../core/models.cjs');
const entries = process.argv.slice(2);
if (!entries.length || entries.some(file => !path.isAbsolute(file) || !fs.statSync(file).isFile()))
  throw Error('Pass absolute installed Codex executable or CLI JavaScript paths');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-native-catalog-'));
const home = path.join(root, 'home'); fs.mkdirSync(home);
const env = { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
  TEMP: root, TMP: root, TMPDIR: root, TERM: 'dumb', NO_COLOR: '1', DO_NOT_TRACK: '1',
  HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
env.PATH = [path.dirname(process.execPath), path.join(env.SystemRoot || '/usr', 'System32')].join(path.delimiter);
const catalog = path.join(home, 'catalog.json');
fs.writeFileSync(path.join(home, 'config.toml'), TOML.stringify({ model_catalog_json: catalog,
  analytics: { enabled: false }, mcp_servers: { rea: { command: process.execPath, args: ['--version'], enabled: false } } }));
const native = { ...makeCatalog([], []).models[0], base_instructions: undefined,
  model_messages: { instructions_template: 'Literal native instructions {{unchanged}}' } };
delete native.supports_parallel_tool_calls; // Modern cache omits this removed legacy field too.
const provider = { id: 'fixture', name: 'Fixture', enabled: true, models: [{ model: 'm', displayName: 'M', enabled: true,
  wireApi: 'openai-responses', contextWindow: 64000, efforts: ['low'], defaultEffort: 'low' }] };
try {
  const results = [];
  for (const entry of entries) {
    const binary = /\.[cm]?js$/.test(entry) ? process.execPath : entry, prefix = binary === entry ? [] : [entry];
    const run = args => spawnSync(binary, [...prefix, ...args], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 });
    const version = run(['--version']); assert.equal(version.status, 0, version.stderr);
    const cases = [];
    for (const [name, value] of [['full-fallback', makeCatalog([], [provider])], ['modern-template', makeCatalog([native], [])],
      ['intentional-empty-template', makeCatalog([{ ...native, model_messages: { instructions_template: '' } }], [])]]) {
      fs.writeFileSync(catalog, JSON.stringify(value));
      for (let i = 0; i < 2; i++) {
        const reply = run(['mcp', 'get', 'rea', '--json']); assert.equal(reply.status, 0, name + ': ' + reply.stderr);
        assert.equal(JSON.parse(reply.stdout).name, 'rea');
      }
      cases.push({ name, repeated: true });
    }
    const invalid = { ...native }; delete invalid.model_messages;
    fs.writeFileSync(catalog, JSON.stringify({ models: [invalid] }));
    const failed = run(['mcp', 'get', 'rea', '--json']); assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /base_instructions|instructions_template/);
    results.push({ version: version.stdout.trim(), cases, missingInstructionsRejected: true });
  }
  console.log(JSON.stringify({ passed: true, results, realCredentialsUsed: false, externalInference: false, mcpServersStarted: false }));
} finally {
  const resolved = path.resolve(root), temp = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(temp) || !path.basename(resolved).startsWith('ass-native-catalog-')) throw Error('Unexpected fixture cleanup path');
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }
  catch { console.error('Synthetic fixture remains locked: ' + resolved); }
}
