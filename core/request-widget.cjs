const path = require('node:path');
class RequestWidget {
  constructor({ electron, preferences, read, refreshUsage, model, onChange = () => {} }) {
    const { app, BrowserWindow, ipcMain, screen, Menu, powerMonitor, nativeTheme } = electron;
    Object.assign(this, { app, BrowserWindow, ipcMain, screen, Menu, powerMonitor, nativeTheme, preferences, read, refreshUsage, model, onChange });
    this.rows = new model.WidgetRequests();this.root = path.resolve(__dirname, '..');this.lastScan = 0;
    const owned = event => this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
    this.ipcMain.handle('ass-widget:ready', event => { if (!owned(event)) throw Error('Invalid widget caller');return this.frame(); });
    for (const [name, action] of [['drag', () => this.glass?.drag()],
      ['drag-end', () => { this.glass?.endDrag();this.lastFrame = undefined;this.tick();if (this.positionDirty) this.schedulePositionSave(); }],
      ['menu', () => this.menu()], ['hide', () => this.configure({ enabled: false })]])
      this.ipcMain.on('ass-widget:' + name, event => { if (owned(event)) action(); });
    this.ipcMain.on('ass-widget:layout', (event, count) => {
      if (owned(event) && Number.isInteger(count) && count >= 0) {
        this.visualCount = Math.min(count, this.preferences.state.requestWidget.rows);this.layout();
      }
    });
    this.onLock = () => this.glass?.stop();
    this.onUnlock = () => { if (this.window?.isVisible()) this.startGlass(); };
    this.powerMonitor.on('lock-screen', this.onLock);this.powerMonitor.on('unlock-screen', this.onUnlock);
  }
  public() { return { ...this.preferences.state.requestWidget, error: this.error || '' }; }
  configure(input) {
    this.preferences.update({ requestWidget: input });
    if (this.preferences.state.requestWidget.enabled) { if (!this.window) this.open();else this.layout(); }
    else this.close();
    this.onChange();return this.public();
  }
  open() {
    const settings = this.preferences.state.requestWidget, area = this.screen.getPrimaryDisplay().workArea;
    const source = this.read();this.count = this.rows.update(source.active, source.history.rows, Date.now()).length;
    this.visualCount = this.count;
    const height = this.model.widgetHeight(this.count, settings.rows), width = this.model.widgetWidth(settings.width);
    const display = this.screen.getDisplayNearestPoint({ x: settings.x ?? area.x + area.width - width - 24, y: settings.y ?? area.y + 50 }).workArea;
    const x = Math.max(display.x, Math.min(display.x + display.width - width, settings.x ?? area.x + area.width - width - 24));
    const y = Math.max(display.y, Math.min(display.y + display.height - height, settings.bottom !== undefined ? settings.bottom - height : settings.y ?? area.y + 50));
    this.window = new this.BrowserWindow({ width, height, x, y, type: 'toolbar', frame: false, transparent: true,
      // Keep size constraints open for native animation. resizable:false also
      // clamps direct Win32 resize requests to the initial client size.
      resizable: true, maximizable: false, minimizable: false, fullscreenable: false, hasShadow: false, useContentSize: true, thickFrame: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#00000000', title: 'ASS · 实时请求',
      webPreferences: { preload: path.join(this.root, 'electron/request-widget-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window.setAlwaysOnTop(true, 'floating');this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.loadFile(path.join(this.root, 'dist/request-widget.html'));
    this.window.once('ready-to-show', () => { this.window?.showInactive();this.startGlass();this.tick(); });
    this.window.on('move', () => {
      this.positionDirty = true;
      this.schedulePositionSave();
    });
    this.window.on('closed', () => { this.glass?.stop();this.window = null;clearInterval(this.timer); });
    this.window.on('close', event => { event.preventDefault();this.configure({ enabled: false }); });
    this.timer = setInterval(() => this.tick(), 1000);
  }
  startGlass() {
    try {
      const directory = this.app.isPackaged ? path.join(process.resourcesPath, 'desktop-glass') : path.join(this.root, 'native/bin/desktop-glass');
      this.glass ||= require(path.join(directory, 'RequestGlass.node'));
      const settings = this.preferences.state.requestWidget;
      this.glass.options({ radius: settings.radius, inset: 10, width: this.model.widgetWidth(settings.width), height: this.model.widgetHeight(this.visualCount ?? this.count, settings.rows),
        rows: Math.min(settings.rows, this.visualCount ?? this.count), reducedMotion: this.nativeTheme.prefersReducedMotion ? 1 : 0 });
      this.glass.start(this.window.getNativeWindowHandle());this.error = '';
    } catch (error) { this.error = '桌面玻璃不可用：' + error.message;this.onChange(); }
  }
  layout() {
    if (!this.window) return;
    const settings = this.preferences.state.requestWidget;
    const count = this.visualCount ?? this.count ?? 0, height = this.model.widgetHeight(count, settings.rows), width = this.model.widgetWidth(settings.width);
    if (this.glass) this.glass.options({ radius: settings.radius, inset: 10, width, height, rows: Math.min(settings.rows, count) });
    else { const [w, h] = this.window.getContentSize();if (w !== width || h !== height) this.window.setContentSize(width, height, false); }
  }
  schedulePositionSave() { clearTimeout(this.positionTimer);this.positionTimer = setTimeout(() => this.savePosition(), 200); }
  savePosition() {
    if (!this.window || !this.positionDirty || this.glass?.stats().dragging) return;
    const [x, y] = this.window.getPosition(), [, height] = this.window.getContentSize();
    this.preferences.update({ requestWidget: { x, y, bottom: y + height } });this.positionDirty = false;
  }
  frame(glass = this.glass?.stats() || null) {
    const source = this.read(), now = Date.now(), rows = this.rows.update(source.active, source.history.rows, now);
    this.count = rows.length;
    const heatKey = [source.usage.updatedAt, source.history.revision, new Date(now).toDateString(), new Date(now).getHours()].join('|');
    if (heatKey !== this.heatKey) { this.heat = this.model.todayHeatmap(source.usage, source.history.rows, now);this.heatKey = heatKey; }
    if (now - this.lastScan >= 60000) {
      this.lastScan = now;void this.refreshUsage();
    }
    if (glass?.readbackBytes) {
      if (glass.luminance > .58) this.light = true;
      else if (glass.luminance < .36) this.light = false;
    }
    return { rows, heat: this.heat, radius: this.preferences.state.requestWidget.radius, capacity: this.preferences.state.requestWidget.rows,
      theme: (this.light ?? !this.nativeTheme.shouldUseDarkColors) ? 'light' : 'dark', glass: !!glass?.presented && !glass?.error, error: this.error || '' };
  }
  tick() {
    if (!this.window || this.window.webContents.isLoading()) return;
    const glass = this.glass?.stats() || null;
    if (glass?.dragging) return;
    const frame = this.frame(glass), signature = JSON.stringify(frame);
    if (signature === this.lastFrame) return;
    this.lastFrame = signature;this.window.webContents.send('ass-widget:data', frame);
  }
  menu() {
    const settings = this.preferences.state.requestWidget;
    const choices = (key, values, label) => values.map(value => ({ label: label(value), type: 'radio', checked: settings[key] === value,
      click: () => this.configure({ [key]: value }) }));
    this.Menu.buildFromTemplate([
      { label: '宽度', submenu: choices('width', [340, 380, 420], value => this.model.widgetWidth(value) + ' px') },
      { label: '圆角', submenu: choices('radius', [12, 24, 36, 48], value => value + ' px') },
      { label: '行数', submenu: choices('rows', [3, 5, 8], String) },
      { type: 'separator' },{ label: '关闭悬浮窗', click: () => this.configure({ enabled: false }) },
    ]).popup({ window: this.window });
  }
  close() {
    clearInterval(this.timer);clearTimeout(this.positionTimer);this.glass?.stop();
    if (this.window) this.window.destroy();this.window = null;this.positionDirty = false;this.visualCount = undefined;this.lastFrame = undefined;this.rows = new this.model.WidgetRequests();
  }
  dispose() { this.close();this.powerMonitor.removeListener('lock-screen', this.onLock);this.powerMonitor.removeListener('unlock-screen', this.onUnlock); }
}
module.exports = { RequestWidget };
