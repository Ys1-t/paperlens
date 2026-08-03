// 渲染进程桥：只暴露白名单 API，保持 contextIsolation。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperlens', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  ask: (question) => ipcRenderer.invoke('chat:ask', question),
  resetChat: () => ipcRenderer.invoke('chat:reset'),
  setPaper: (paper) => ipcRenderer.invoke('paper:set', paper),
  translatePage: (payload) => ipcRenderer.invoke('paper:translate-page', payload),
  onTranslateDelta: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('translate:delta', listener);
    return () => ipcRenderer.removeListener('translate:delta', listener);
  },
  onChatEvent: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },
});
