const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
test('shared UI chrome uses neutral/sage tokens without blue literals or cyclic border variables', () => {
  for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.css') && f !== 'usage-meter.css')) {
    const css = fs.readFileSync(path.join(src, file), 'utf8');
    assert.ok(!/--([\w-]+)\s*:\s*var\(--\1\)\s*;/.test(css), file + ' has a cyclic token');
    for (const match of css.matchAll(/#[\da-f]{6}(?:[\da-f]{2})?\b/gi)) {
      // Usage data is sky blue in light mode and violet in dark mode;
      // the exception is confined to data colors, not general UI chrome.
      if (file === 'overview.css' && ['#155d85', '#218dc0', '#61b8df', '#ade0f3', '#49325f', '#74509b', '#9f76c7', '#c79aed'].includes(match[0])) continue;
      const rgb = [1, 3, 5].map((i) => parseInt(match[0].slice(i, i + 2), 16)), max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min;
      if (delta < 3) continue;
      let hue = max === rgb[0] ? ((rgb[1] - rgb[2]) / delta + 6) % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4;
      hue *= 60;
      assert.ok(hue < 180 || hue > 280, file + ' retains blue chrome: ' + match[0]);
    }
  }
});
test('quota dark appearance and animation stay unchanged while explicit light palette overrides are allowed', () => {
  // Snapshot of v0.2.13, independent of Git history / shallow checkouts.
  const css = fs.readFileSync(path.join(src, 'usage-meter.css'), 'utf8').replaceAll('\r\n', '\n');
  const overrides = ['light-dark(#147cba, #7555d7)', 'light-dark(#389dce, #9866de)', 'light-dark(#80d0ee, #b68bdd)', 'light-dark(#effaff, #f4ebff)'];
  let dark = css.replace(/^:root\[data-color-theme="light"\] \.usage-meter-fill \{[^}]*\}\n/m, '');
  for (const value of overrides) {
    assert.ok(css.includes(value), 'missing explicit light/dark palette: ' + value);
    dark = dark.replaceAll(value, value.match(/, (#[\da-f]+)\)/)[1]);
  }
  assert.equal(crypto.createHash('sha256').update(dark).digest('hex'), '3b94cb073c0f331d16a829bd4400ba59fb8152e777797314638372046f19cfa2');
});
test('conversation layout has one search, compact context, explicit pin help and sidebar-only nav geometry', () => {
  const jsx = fs.readFileSync(path.join(src, 'project-conversations.jsx'), 'utf8');
  assert.equal((jsx.match(/type="search"/g) || []).length, 1);
  assert.ok(jsx.includes('搜索项目或对话') && jsx.includes('project-conversations-search'));
  assert.ok(!jsx.includes('<h2>{project.name}</h2>'));
  assert.ok(jsx.includes('aria-describedby="conversation-pin-description"') && jsx.includes('只显示当前项目的置顶对话'));
  for (const file of ['style.css', 'polish.css']) assert.ok(!/^nav(?:\s|\s+button)/m.test(fs.readFileSync(path.join(src, file), 'utf8')), file + ' must not leak sidebar geometry into conversation controls');
});
test('native title bar matches the neutral surface and shares responsive sidebar width with the header brand', () => {
  const css = fs.readFileSync(path.join(src, 'theme.css'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
  const jsx = fs.readFileSync(path.join(src, 'main.jsx'), 'utf8');
  assert.ok(css.includes('--sidebar-width: 218px') && css.includes('--sidebar-width: 198px'));
  assert.ok(css.includes('margin-left: var(--sidebar-width)') && css.includes('width: var(--sidebar-width)'));
  assert.ok(css.includes('var(--sidebar-surface) var(--sidebar-width), var(--surface) var(--sidebar-width)'));
  assert.ok(css.includes('.window-chrome .version-button { -webkit-app-region: no-drag'));
  assert.ok(jsx.includes('aria-label="应用顶栏">{brand}<WindowControls') && jsx.includes('!api.windowChrome && brand'));
  assert.ok(main.includes('titleBarOverlay: false') && !main.includes('window.setTitleBarOverlay('));
  assert.ok(css.includes('height: var(--window-chrome-height); z-index: 100'));
  assert.ok(css.includes('.modal::backdrop { inset: var(--window-chrome-height) 0 0; }'));
  assert.ok(!css.includes('filter: grayscale(1)'));
  assert.ok(main.includes('"#1a1a1a" : "#f3f3f3"'));
  assert.ok(main.includes('height: 44') && css.includes('--window-chrome-height: 44px'));
  assert.ok(css.includes('.brand .ass-logo { width: 40px; height: 40px; }'));
  assert.ok(css.includes('font-size: 26px') && css.includes('font-size: 10px; font-weight: 500; line-height: 14px'));
  assert.ok(css.includes('--surface: light-dark(#f3f3f3, #1a1a1a)'));
  assert.ok(css.includes('transform: translateY(2px)'));
  assert.ok(css.includes('transform: translateY(15px)') && css.includes('var(--window-chrome-height) + 27px'));
  assert.ok(!main.includes('#161b23') && !main.includes('#f3f5f8'));
});

test('light usage heat cells, legend, token chart and model bars share a sky palette with unchanged dark violet', () => {
  const css = fs.readFileSync(path.join(src, 'overview.css'), 'utf8');
  for (const [i, light, dark] of [[1, '#155d85', '#49325f'], [2, '#218dc0', '#74509b'], [3, '#61b8df', '#9f76c7'], [4, '#ade0f3', '#c79aed']]) {
    assert.ok(css.includes(`--usage-level-${i}: light-dark(${light}, ${dark})`));
    assert.ok(css.includes(`background: var(--usage-level-${i})`));
  }
  assert.ok(css.includes('.heatmap-cell') && css.includes('.heatmap-legend') && css.includes('.usage-group-track i'));
  const conversations = fs.readFileSync(path.join(src, 'conversations.css'), 'utf8');
  assert.ok(conversations.includes('background: light-dark(#d1d5d2, #303030)'));
});

test('theme logo preserves the authoritative petals and orange hub without recoloring system icons', () => {
  const component = fs.readFileSync(path.join(src, 'ass-logo.jsx'), 'utf8');
  const css = fs.readFileSync(path.join(src, 'theme.css'), 'utf8');
  assert.ok(component.includes('../public/ass-logo.svg?raw') && component.includes('hub-fitted'));
  assert.ok(component.includes('./ass-app-icon.png') && component.includes('aria-hidden="true"'));
  assert.ok(css.includes('background: light-dark(#151515, transparent)'));
  for (const file of ['main.jsx', 'about-brand.jsx']) assert.match(fs.readFileSync(path.join(src, file), 'utf8'), /<AssLogo(?: interactive)? \/>/);
});

test('only light heatmaps and their legend go from light for less activity to dark for more', () => {
  const css = fs.readFileSync(path.join(src, 'overview.css'), 'utf8');
  const heatmap = css.match(/\.usage-heatmap\s*\{([^}]+)\}/)[1];
  const palette = ['#ade0f3', '#61b8df', '#218dc0', '#155d85'];
  const dark = ['#49325f', '#74509b', '#9f76c7', '#c79aed'];
  const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  for (let i = 0; i < palette.length; i++) {
    assert.ok(heatmap.includes(`--usage-level-${i + 1}: light-dark(${palette[i]}, ${dark[i]})`));
    if (i) assert.ok(luminance(palette[i - 1]) > luminance(palette[i]));
  }
  // Base chart tokens stay unchanged: inversion is confined to .usage-heatmap.
  const overview = css.match(/\.usage-overview\s*\{([^}]+)\}/)[1];
  assert.ok(overview.includes('--usage-level-1: light-dark(#155d85, #49325f)'));
  assert.ok(overview.includes('--usage-level-4: light-dark(#ade0f3, #c79aed)'));
});
