const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { makeCatalog, catalogInstructions, compatibleCatalogModel } = require('../core/models.cjs');
const { Store } = require('../core/store.cjs');
const crypt = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
const valid = model => typeof model.base_instructions === 'string' || typeof model.model_messages?.instructions_template === 'string';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-catalog-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('empty official cache produces a complete catalog with instructions for every row, repeatedly', () => {
  const provider = { id: 'fixture', name: 'Fixture', enabled: true, models: [
    { model: 'm', displayName: 'M', enabled: true, wireApi: 'openai-responses', contextWindow: 64000, efforts: ['low'], defaultEffort: 'low' },
  ] };
  for (const providers of [[], [provider]]) {
    const first = makeCatalog([], providers);
    assert.equal(first.models.every(valid), true);
    assert.deepEqual(makeCatalog([], providers), first);
    assert.ok(first.models[0].supported_reasoning_levels.length);
    assert.equal(first.models[0].truncation_policy.mode, 'bytes');
  }
});

test('Store missing, corrupt and empty cache fallbacks use a complete schema and leave native files unchanged', t => {
  const root = fixture(t), cache = path.join(root, 'models_cache.json');
  for (const value of [null, '{broken', '{"models":[]}']) {
    if (value !== null) fs.writeFileSync(cache, value);
    for (let i = 0; i < 2; i++) {
      const store = new Store(path.join(root, 'data'), root, crypt);
      assert.deepEqual(store.officialModels, makeCatalog([], []).models);
      const catalog = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'catalog-draft.json')));
      assert.equal(catalog.models.every(valid), true);
      assert.ok(catalog.models[0].supported_reasoning_levels.length);
      if (value === null) assert.equal(fs.existsSync(cache), false);
      else assert.equal(fs.readFileSync(cache, 'utf8'), value);
    }
  }
});

test('legacy catalog fills only the missing instruction field without mutating native metadata', () => {
  for (const partial of [{}, { base_instructions: null, model_messages: null },
    { model_messages: { instructions_template: null, approvals: { never: 'retain' } } }]) {
    const native = { slug: 'native-fixture', context_window: 500000, max_context_window: 800000, default_reasoning_level: 'low',
      supports_parallel_tool_calls: true, future_field: { retained: true }, ...partial }, original = JSON.stringify(native);
    const result = makeCatalog([native], []).models[0], { base_instructions, ...rest } = result;
    const { base_instructions: previous, ...expected } = native;
    assert.ok(base_instructions.length); assert.deepEqual(rest, expected);
    assert.equal(JSON.stringify(native), original);
    assert.deepEqual(catalogInstructions(result), result);
  }
});

test('native legacy and modern prompts, intentional empty strings and mixed fields remain exact', () => {
  for (const instructions of [
    { base_instructions: 'Exact native instructions {{literal}}' }, { base_instructions: '' },
    { model_messages: { instructions_template: 'Exact modern instructions', future: 'retain' } },
    { model_messages: { instructions_template: '' } },
    { base_instructions: 'legacy source', model_messages: { instructions_template: 'modern source' } },
  ]) {
    const native = { slug: 'native', context_window: 500000, max_context_window: 900000,
      supports_parallel_tool_calls: true, supported_reasoning_levels: [{ effort: 'low', description: 'Native' }], future: { native: true }, ...instructions };
    const expected = typeof native.base_instructions === 'string' ? native : { ...native, base_instructions: native.model_messages.instructions_template };
    if (typeof native.base_instructions === 'string') assert.equal(catalogInstructions(native), native);
    else assert.equal(catalogInstructions(native).base_instructions, native.model_messages.instructions_template);
    assert.deepEqual(makeCatalog([native], [], { native: { contextWindow: 272000, enabled: false } }).models[0], expected);
    assert.deepEqual(native, { slug: 'native', context_window: 500000, max_context_window: 900000,
      supports_parallel_tool_calls: true, supported_reasoning_levels: [{ effort: 'low', description: 'Native' }], future: { native: true }, ...instructions });
  }
  for (const parallel of [undefined, null, true, false]) {
    const native = { slug: 'native', model_messages: { instructions_template: 'Native' }, supports_parallel_tool_calls: parallel };
    const result = compatibleCatalogModel(native);
    assert.equal(result.supports_parallel_tool_calls, parallel ?? false);
    assert.equal(result.model_messages, native.model_messages);
    assert.equal(compatibleCatalogModel(result), result);
  }
  assert.throws(() => compatibleCatalogModel({ slug: 'invalid', base_instructions: '', supports_parallel_tool_calls: 'true' }), /必须为布尔值/);
});

test('malformed instruction types fail explicitly without replacing the input with generic instructions', () => {
  for (const fields of [{ base_instructions: 42 }, { model_messages: { instructions_template: [] } }]) {
    const native = { slug: 'invalid', ...fields }, before = JSON.stringify(native);
    assert.throws(() => makeCatalog([native], []), /指令字段必须为字符串/);
    assert.equal(JSON.stringify(native), before);
  }
});
