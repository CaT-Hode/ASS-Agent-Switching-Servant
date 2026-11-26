const path = require('node:path');
class RequestWidget {
  constructor({ electron, preferences, read, refreshUsage, model, onChange = () => {} }) {
    const { app, BrowserWindow, ipcMain, screen, powerMonitor, nativeTheme } = electron;
    Object.assign(this, { app, BrowserWindow, ipcMain, screen, powerMonitor, nativeTheme, preferences, read, refreshUsage, model, onChange });
    this.rows = new model.WidgetRequests();this.root = path.resolve(__dirname, '..');this.lastScan = 0;
    this.isDragging = false;this.glassReady = false;
    this.lastThemePresented = -1;this.lastThemeReadback = -1;this.lastThemeSent = '';
    const owned = event => this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
    this.ipcMain.handle('ass-widget:ready', event => { if (!owned(event)) throw Error('Invalid widget caller');this.checkTheme();return this.frame(true); });
    for (const [name, action] of [
      ['drag', () => { this.isDragging = true;this.glass?.drag();this.scheduleThemeCheck(true); }],
      ['drag-end', () => { this.isDragging = false;this.glass?.endDrag();this.lastFrame = undefined;this.positionDirty = true;this.checkTheme();this.tick();this.schedulePositionSave(); }],
      ['hide', () => this.configure({ enabled: false })]])
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
    if (this.preferences.state.requestWidget.enabled) { if (!this.window) this.open();else { this.layout();this.tick(); } }
    else this.close();
    this.onChange();return this.public();
  }
  notifyActivity() {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoading() || this.isDragging) return;
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.tick();
    }, 90);
    this.activityTimer.unref?.();
  }
  scheduleNextTick(activeOrResting) {
    clearTimeout(this.timer);
    if (!this.window || this.window.isDestroyed()) return;
    const { showHeatmap, showUsage } = this.preferences.state.requestWidget;
    let delay = 1000;
    if (!activeOrResting && showHeatmap === false && !showUsage) delay = 60000;
    else if (!activeOrResting) {
      const now = Date.now();
      const nextHourMs = 3600000 - (now % 3600000) + 250;
      const nextScanMs = Math.max(5000, 60000 - (now - this.lastScan));
      delay = Math.max(5000, Math.min(60000, nextHourMs, nextScanMs));
    }
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }
  scheduleThemeCheck(fast) {
    clearTimeout(this.themeTimer);
    if (!this.window || this.window.isDestroyed()) return;
    this.themeTimer = setTimeout(() => {
      this.checkTheme();
      const needFast = this.isDragging || !this.glassReady;
      this.scheduleThemeCheck(needFast);
    }, fast ? 320 : 2500);
    this.themeTimer.unref?.();
  }
  // Completely decoupled from 1s content ticks: polls lock-free native glass stats only on its own cadence.
  checkTheme() {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoading() || !this.glass) return;
    const glass = this.glass.stats();
    if (!glass) return;
    if (this.isDragging && !glass.dragging) this.isDragging = false;
    if (glass.presented === this.lastThemePresented && glass.readbackBytes === this.lastThemeReadback) return;
    this.lastThemePresented = glass.presented;
    this.lastThemeReadback = glass.readbackBytes;
    if (glass.readbackBytes) {
      if (glass.luminance > .58) this.light = true;
      else if (glass.luminance < .36) this.light = false;
    }
    const theme = (this.light ?? !this.nativeTheme.shouldUseDarkColors) ? 'light' : 'dark';
    this.glassReady = !!glass.presented && !glass.error;
    const key = `${theme}|${this.glassReady ? 1 : 0}`;
    if (key === this.lastThemeSent) return;
    this.lastThemeSent = key;
    this.window.webContents.send('ass-widget:theme', { theme, glass: this.glassReady });
  }
  open() {
    const settings = this.preferences.state.requestWidget, area = this.screen.getPrimaryDisplay().workArea;
    const source = this.read();this.count = this.rows.update(source.active, source.history.rows, Date.now()).length;
    this.visualCount = this.count;
    const height = this.model.widgetHeight(this.count, settings.rows, settings.width, settings.showHeatmap, settings.showUsage,
      settings.quotaBars?.length, settings.radius);
    const width = this.model.widgetWidth(settings.width);
    const display = this.screen.getDisplayNearestPoint({ x: settings.x ?? area.x + area.width - width - 24, y: settings.y ?? area.y + 50 }).workArea;
    const x = Math.max(display.x, Math.min(display.x + display.width - width, settings.x ?? area.x + area.width - width - 24));
    const y = Math.max(display.y, Math.min(display.y + display.height - height, settings.bottom !== undefined ? settings.bottom - height : settings.y ?? area.y + 50));
    this.window = new this.BrowserWindow({ width, height, x, y, type: 'toolbar', frame: false, transparent: true,
      resizable: true, maximizable: false, minimizable: false, fullscreenable: false, hasShadow: false, useContentSize: true, thickFrame: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#00000000', title: 'ASS · 实时请求',
      webPreferences: { preload: path.join(this.root, 'electron/request-widget-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    this.window.setAlwaysOnTop(true, 'floating');this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.loadFile(path.join(this.root, 'dist/request-widget.html'));
    this.window.once('ready-to-show', () => { this.window?.showInactive();this.startGlass();this.checkTheme();this.tick();this.scheduleThemeCheck(true); });
    this.window.on('closed', () => {
      this.glass?.stop();this.window = null;this.isDragging = false;
      clearTimeout(this.timer);clearTimeout(this.activityTimer);clearTimeout(this.themeTimer);
      this.timer = this.activityTimer = this.themeTimer = null;
    });
    this.window.on('close', event => { event.preventDefault();this.configure({ enabled: false }); });
    this.scheduleNextTick(this.count > 0);
  }
  startGlass() {
    try {
      const directory = this.app.isPackaged ? path.join(process.resourcesPath, 'desktop-glass') : path.join(this.root, 'native/bin/desktop-glass');
      this.glass ||= require(path.join(directory, 'RequestGlass.node'));
      this.glass.options({ ...this.glassOptions(), reducedMotion: this.nativeTheme.prefersReducedMotion ? 1 : 0 });
      this.glass.start(this.window.getNativeWindowHandle());this.error = '';
    } catch (error) { this.error = '桌面玻璃不可用：' + error.message;this.onChange(); }
  }
  glassOptions() {
    const settings = this.preferences.state.requestWidget, count = this.visualCount ?? this.count ?? 0;
    const showHeatmap = settings.showHeatmap !== false;
    const showUsage = settings.showUsage === true;
    const quotaCount = settings.quotaBars?.length ?? 0;
    const insets = this.model.widgetContentInsets(settings.radius);
    return { radius: settings.radius, bezelWidth: settings.bezelWidth, distortion: settings.distortion,
      inset: this.model.WIDGET_FRAME_INSET, width: this.model.widgetWidth(settings.width),
      height: this.model.widgetHeight(count, settings.rows, settings.width, showHeatmap, showUsage, quotaCount, settings.radius),
      rows: Math.min(settings.rows, count),
      heatHeight: showHeatmap ? this.model.widgetHeatHeight(settings.width, settings.radius) : 0, rowHeight: this.model.WIDGET_ROW_HEIGHT,
      summaryHeight: showUsage ? this.model.WIDGET_USAGE_HEIGHT + (showHeatmap ? this.model.WIDGET_SECTION_GAP : 0) : 0,
      quotaHeight: this.model.widgetQuotaHeight(quotaCount),
      contentInset: insets.horizontal, sectionGap: showHeatmap || showUsage ? this.model.WIDGET_SECTION_GAP : 0,
      heatBottom: insets.bottom };
  }
  layout() {
    if (!this.window) return;
    const options = this.glassOptions(), { width, height } = options;
    if (this.glass) this.glass.options(options);
    else { const [w, h] = this.window.getContentSize();if (w !== width || h !== height) this.window.setContentSize(width, height, false); }
  }
  schedulePositionSave() { clearTimeout(this.positionTimer);this.positionTimer = setTimeout(() => this.savePosition(), 200); }
  savePosition() {
    if (!this.window || !this.positionDirty || this.isDragging || this.glass?.stats().dragging) return;
    const [x, y] = this.window.getPosition(), [, height] = this.window.getContentSize();
    this.preferences.update({ requestWidget: { x, y, bottom: y + height } });this.positionDirty = false;
  }
  // Content-only frame builder: never touches native glass stats during 1s content ticks.
  frame(includeHeat = false) {
    const { rows: capacity, columns, showHeatmap = true, showUsage = false, radius } = this.preferences.state.requestWidget;
    const source = this.read(), now = Date.now(), rows = this.rows.update(source.active, source.history.rows, now);
    this.count = rows.length;
    const usageUpdatedAt = source.usageUpdatedAt !== undefined ? source.usageUpdatedAt : source.usage?.updatedAt;
    const day = new Date(now);
    const usageKey = showHeatmap || showUsage ? [usageUpdatedAt, source.history.revision, day.toDateString(), day.getHours()].join('|') : null;
    const usageChanged = usageKey !== this.usageKey;
    const heatKey = showHeatmap ? usageKey : null;
    const heatChanged = heatKey !== this.heatKey;
    this.usageKey = usageKey;
    this.heatKey = heatKey;
    if (usageKey !== null) {
      if (usageChanged) {
        const usage = source.usage || source.readUsage?.() || { rows: [] };
        this.heat = this.model.todayHeatmap(usage, source.history.rows, now);
        const { total, input, output } = this.heat;
        this.usageSummary = { total, input, output };
      }
      if (now - this.lastScan >= 60000) {
        this.lastScan = now;void this.refreshUsage();
      }
    }
    const theme = (this.light ?? !this.nativeTheme.shouldUseDarkColors) ? 'light' : 'dark';
    return { rows: rows.slice(0, capacity), ...(showHeatmap && (heatChanged || includeHeat) ? { heat: this.heat } : {}), usageKey,
      ...(showUsage ? { usageSummary: this.usageSummary } : {}), radius, columns, showHeatmap, showUsage, quotaBars: source.quotaBars ?? [],
      theme, glass: this.glassReady, error: this.error || '' };
  }
  tick() {
    if (!this.window || this.window.isDestroyed() || this.window.webContents.isLoading()) return;
    if (this.isDragging) { this.scheduleNextTick(true);return; }
    const frame = this.frame();
    const signature = JSON.stringify({
      rows: frame.rows, usageKey: frame.usageKey, radius: frame.radius,
      columns: frame.columns, showHeatmap: frame.showHeatmap, showUsage: frame.showUsage, quotaBars: frame.quotaBars,
      theme: frame.theme, glass: frame.glass, error: frame.error,
    });
    this.scheduleNextTick(frame.rows.length > 0);
    if (signature === this.lastFrame) return;
    this.lastFrame = signature;this.window.webContents.send('ass-widget:data', frame);
  }
  close() {
    clearTimeout(this.timer);clearTimeout(this.activityTimer);clearTimeout(this.themeTimer);clearTimeout(this.positionTimer);
    this.timer = this.activityTimer = this.themeTimer = this.positionTimer = null;
    this.glass?.stop();
    if (this.window) this.window.destroy();this.window = null;this.positionDirty = false;this.isDragging = false;this.glassReady = false;
    this.visualCount = undefined;this.lastFrame = undefined;
    this.lastThemePresented = -1;this.lastThemeReadback = -1;this.lastThemeSent = '';
    this.rows = new this.model.WidgetRequests();
  }
  dispose() { this.close();this.powerMonitor.removeListener('lock-screen', this.onLock);this.powerMonitor.removeListener('unlock-screen', this.onUnlock); }
}
module.exports = { RequestWidget };
