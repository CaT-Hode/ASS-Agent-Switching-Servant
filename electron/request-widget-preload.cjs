const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('requestWidget', {
  ready: () => ipcRenderer.invoke('ass-widget:ready'),
  drag: () => ipcRenderer.send('ass-widget:drag'),
  endDrag: () => ipcRenderer.send('ass-widget:drag-end'),
  menu: () => ipcRenderer.send('ass-widget:menu'),
  hide: () => ipcRenderer.send('ass-widget:hide'),
  layout: count => ipcRenderer.send('ass-widget:layout', count),
  subscribe: callback => { const listener = (_, value) => callback(value);ipcRenderer.on('ass-widget:data', listener);
    return () => ipcRenderer.removeListener('ass-widget:data', listener); },
});
