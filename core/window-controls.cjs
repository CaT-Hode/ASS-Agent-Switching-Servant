// Only the owned ASS window, never a harness process or an arbitrary window.
const actions = new Set(['state', 'minimize', 'toggle-maximize', 'close']);
function windowState(window) {
  if (!window || window.isDestroyed()) throw Error('ASS 窗口不可用');
  return { maximized: window.isMaximized(), minimized: window.isMinimized(),
    focused: window.isFocused(), visible: window.isVisible() };
}
function windowAction(window, action) {
  if (!actions.has(action)) throw Error('不支持的窗口操作');
  windowState(window);
  if (action === 'minimize') window.minimize();
  else if (action === 'toggle-maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
  else if (action === 'close') window.close(); // Existing close listener hides to tray.
  return windowState(window);
}
module.exports = { windowState, windowAction };
