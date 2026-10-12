const { test } = require('node:test'), assert = require('node:assert/strict');
const { windowState, windowAction } = require('../core/window-controls.cjs');
function fixture() {
  let maximized = false, minimized = false, visible = true;
  const calls = [], window = { isDestroyed: () => false, isMaximized: () => maximized, isMinimized: () => minimized,
    isFocused: () => visible && !minimized, isVisible: () => visible,
    maximize() { calls.push('maximize'); maximized = true; }, unmaximize() { calls.push('unmaximize'); maximized = false; },
    minimize() { calls.push('minimize'); minimized = true; }, close() { calls.push('close'); visible = false; } };
  return { window, calls };
}
test('window controls read state without mutations and toggle maximize/restore correctly', () => {
  const f = fixture(); assert.equal(windowAction(f.window, 'state').maximized, false); assert.deepEqual(f.calls, []);
  assert.equal(windowAction(f.window, 'toggle-maximize').maximized, true);
  assert.equal(windowAction(f.window, 'toggle-maximize').maximized, false);
  assert.deepEqual(f.calls, ['maximize', 'unmaximize']);
});
test('minimize and close call only the owned window, preserving its close-to-tray lifecycle', () => {
  const f = fixture(); assert.equal(windowAction(f.window, 'minimize').minimized, true);
  assert.equal(windowAction(f.window, 'close').visible, false); assert.equal(f.window.isDestroyed(), false);
  assert.deepEqual(f.calls, ['minimize', 'close']);
});
test('window actions reject arbitrary commands and unavailable windows before any mutation', () => {
  const f = fixture();
  for (const action of ['quit', 'destroy', 'executeJavaScript', { action: 'close' }, null]) assert.throws(() => windowAction(f.window, action));
  assert.deepEqual(f.calls, []); assert.throws(() => windowState(null));
  assert.throws(() => windowAction({ isDestroyed: () => true }, 'close'));
});
