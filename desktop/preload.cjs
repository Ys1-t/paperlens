// 渲染进程桥：只暴露白名单 API，保持 contextIsolation。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paperlens', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  ask: (question, opts) => ipcRenderer.invoke('chat:ask', question, opts || {}),
  cancelChat: () => ipcRenderer.invoke('chat:cancel'),
  listSkills: () => ipcRenderer.invoke('chat:skills'),
  respondToolConfirm: (payload) => ipcRenderer.invoke('chat:confirm-response', payload || {}),
  resetChat: () => ipcRenderer.invoke('chat:reset'),
  setPaper: (paper) => ipcRenderer.invoke('paper:set', paper),
  setAgentMode: (mode) => ipcRenderer.invoke('workspace:set-agent-mode', mode),
  listTodos: (opts) => ipcRenderer.invoke('workspace:todos', opts || {}),
  addTodo: (payload) => ipcRenderer.invoke('workspace:add-todo', payload || {}),
  setTodoDone: (payload) => ipcRenderer.invoke('workspace:set-todo-done', payload || {}),
  translatePage: (payload) => ipcRenderer.invoke('paper:translate-page', payload),
  translateSelection: (payload) => ipcRenderer.invoke('translate:selection', payload),
  pickPdf: () => ipcRenderer.invoke('paper:pick-file'),
  openPdfPath: (path) => ipcRenderer.invoke('paper:open-path', path),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  touchRecent: (entry) => ipcRenderer.invoke('workspace:touch-recent', entry),
  lockTerm: (payload) => ipcRenderer.invoke('workspace:lock-term', payload),
  listGlossary: () => ipcRenderer.invoke('workspace:list-glossary'),
  removeTerm: (term) => ipcRenderer.invoke('workspace:remove-term', { term }),
  addNote: (note) => ipcRenderer.invoke('workspace:add-note', note),
  removeNote: (id) => ipcRenderer.invoke('workspace:remove-note', id),
  exportNotes: () => ipcRenderer.invoke('workspace:export-notes'),
  pickObsidianFolder: () => ipcRenderer.invoke('obsidian:pick-folder'),
  obsidianStatus: () => ipcRenderer.invoke('obsidian:status'),
  setObsidianEnabled: (enabled) => ipcRenderer.invoke('obsidian:set-enabled', enabled),
  writeNoteToObsidian: (note) => ipcRenderer.invoke('obsidian:write-note', note),
  // v0.2 科研工作台
  setUiPrefs: (patch) => ipcRenderer.invoke('workspace:set-ui-prefs', patch || {}),
  setProfile: (patch) => ipcRenderer.invoke('workspace:set-profile', patch || {}),
  setInterests: (payload) => ipcRenderer.invoke('workspace:set-interests', payload || {}),
  updateLibraryEntry: (path, patch) => ipcRenderer.invoke('workspace:update-library-entry', { path, patch }),
  getLibrary: (opts) => ipcRenderer.invoke('workspace:library', opts || {}),
  removeLibraryEntry: (path) => ipcRenderer.invoke('workspace:remove-library-entry', { path }),
  getVenues: () => ipcRenderer.invoke('workspace:venues'),
  addVenue: (entry) => ipcRenderer.invoke('workspace:add-venue', entry || {}),
  removeVenue: (id) => ipcRenderer.invoke('workspace:remove-venue', id),
  getReadingList: () => ipcRenderer.invoke('workspace:reading-list'),
  addReadingItem: (entry) => ipcRenderer.invoke('workspace:add-reading-item', entry || {}),
  setReadingItem: (payload) => ipcRenderer.invoke('workspace:set-reading-item', payload || {}),
  recordStat: (kind, amount) => ipcRenderer.invoke('stats:record', { kind, amount }),
  getStats: () => ipcRenderer.invoke('stats:summary'),
  fetchRadar: () => ipcRenderer.invoke('radar:fetch'),
  radarDigestToVault: (ranked) => ipcRenderer.invoke('radar:digest-to-vault', { ranked }),
  openArxivPdf: (payload) => ipcRenderer.invoke('radar:open-arxiv-pdf', payload || {}),
  kbOverview: () => ipcRenderer.invoke('kb:overview'),
  kbSearch: (payload) => ipcRenderer.invoke('kb:search', payload || {}),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  openSession: (id) => ipcRenderer.invoke('sessions:open', { id }),
  removeSession: (id) => ipcRenderer.invoke('sessions:remove', { id }),
  importFolder: () => ipcRenderer.invoke('library:import-folder'),
  extractMetadata: (payload) => ipcRenderer.invoke('library:extract-metadata', payload || {}),
  listHighlights: (path) => ipcRenderer.invoke('highlights:list', { path }),
  addHighlight: (payload) => ipcRenderer.invoke('highlights:add', payload || {}),
  removeHighlight: (payload) => ipcRenderer.invoke('highlights:remove', payload || {}),
  listDrafts: () => ipcRenderer.invoke('drafts:list'),
  saveDraft: (draft) => ipcRenderer.invoke('drafts:save', draft || {}),
  removeDraft: (id) => ipcRenderer.invoke('drafts:remove', { id }),
  getDraft: (id) => ipcRenderer.invoke('drafts:get', { id }),
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
  onUiShowPage: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('ui:show-page', listener);
    return () => ipcRenderer.removeListener('ui:show-page', listener);
  },
});
