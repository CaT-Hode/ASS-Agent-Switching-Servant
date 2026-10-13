const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), yaml = require('yaml');
const root = path.resolve(__dirname, '..'), skill = path.join(root, 'skills/ass-theme-design');
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
test('portable theme skill has valid discovery metadata, linked resources and no missing imports', () => {
  const entry = text(path.join(skill, 'SKILL.md'));
  const metadata = yaml.parse(entry.match(/^---\n([\s\S]*?)\n---/)[1]);
  assert.equal(metadata.name, 'ass-theme-design'); assert.ok(metadata.description.length > 20);
  const ui = yaml.parse(text(path.join(skill, 'agents/openai.yaml')));
  assert.ok(ui.interface.default_prompt.includes('$ass-theme-design'));
  assert.ok(ui.interface.short_description.length >= 25 && ui.interface.short_description.length <= 64);
  for (const file of ['SKILL.md', 'references/design-system.md', 'references/motion-and-integration.md']) {
    for (const match of text(path.join(skill, file)).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(match[1])) continue;
      assert.ok(fs.existsSync(path.resolve(skill, path.dirname(file), match[1])), 'missing resource ' + match[1]);
    }
  }
  const result = require('esbuild').buildSync({ entryPoints: [path.join(skill, 'assets/theme-control.jsx')],
    bundle: true, write: false, platform: 'browser', external: ['react', 'react-dom'], logLevel: 'silent' });
  assert.equal(result.errors.length, 0); assert.ok(result.outputFiles[0].contents.length > 0);
});
test('skill templates stay aligned with actual theme behavior and have no ASS page or account dependencies', () => {
  for (const [asset, source] of [['theme-control.jsx', 'theme.jsx'], ['theme-motion.mjs', 'theme-motion.mjs'], ['theme-reveal.mjs', 'theme-reveal.mjs']]) {
    assert.equal(text(path.join(skill, 'assets', asset)), text(path.join(root, 'src', source)));
  }
  const css = text(path.join(skill, 'assets/theme-control.css'));
  assert.ok(css.includes('::view-transition-new(root)') && css.includes('@keyframes theme-eclipse'));
  assert.ok(!css.includes('.app-shell') && !css.includes('.diagnostic-content') && !css.includes('.supplier-symbol'));
  for (const file of fs.readdirSync(path.join(skill, 'assets'))) {
    assert.ok(!/window\.ass|D:\\CodexProj|AI Switch Servant|apiKey/.test(text(path.join(skill, 'assets', file))));
  }
});
