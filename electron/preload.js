const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  // Memory
  getMemory: () => ipcRenderer.invoke('memory:get'),
  setMemory: (data) => ipcRenderer.invoke('memory:set', data),

  // Actions
  openApp: (appKey, options) => ipcRenderer.invoke('action:open-app', appKey, options),
  openUrl: (url) => ipcRenderer.invoke('action:open-url', url),
  openUrlInProfile: (url, browser, profile) =>
    ipcRenderer.invoke('action:open-url-profile', { url, browser, profile }),
  openCustom: (target) => ipcRenderer.invoke('action:open-custom', target),
  systemAction: (action) => ipcRenderer.invoke('action:system', action),
  sendWhatsApp: (payload) => ipcRenderer.invoke('action:whatsapp', payload),
  openPath: (query, base) => ipcRenderer.invoke('action:open-path', { query, base }),
  listPath: (query, base) => ipcRenderer.invoke('action:list-path', { query, base }),
  resolvePath: (query, base) => ipcRenderer.invoke('action:resolve-path', { query, base }),
  createFile: (filePath, content) => ipcRenderer.invoke('action:create-file', { filePath, content }),
  openFile: (filePath) => ipcRenderer.invoke('action:open-file', filePath),
  listProfiles: (browser) => ipcRenderer.invoke('action:list-profiles', browser),

  // System info
  getStats: () => ipcRenderer.invoke('system:stats'),
  getDateTime: () => ipcRenderer.invoke('system:datetime'),

  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  showWindow: () => ipcRenderer.invoke('window:show'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),

  // Lets the renderer tell a real desktop session from a plain browser tab
  isElectron: true,

  // Mark LIV: the Gemini Live assistant. The renderer owns the session and
  // the audio; everything privileged is behind these calls.
  mark: {
    configGet: () => ipcRenderer.invoke('mark:config-get'),
    configSet: (fields) => ipcRenderer.invoke('mark:config-set', fields),
    saveApiKey: (key) => ipcRenderer.invoke('mark:api-key-save', key),
    sessionSetup: () => ipcRenderer.invoke('mark:session-setup'),
    runTool: (name, args, extra) => ipcRenderer.invoke('mark:tool-run', name, args, extra),
    captureScreen: () => ipcRenderer.invoke('mark:capture-screen'),

    memoryList: () => ipcRenderer.invoke('mark:memory-list'),
    memoryForget: (category, key) => ipcRenderer.invoke('mark:memory-forget', category, key),
    memoryIdentity: () => ipcRenderer.invoke('mark:memory-identity'),
    popLastSession: () => ipcRenderer.invoke('mark:pop-last-session'),
    saveSessionSummary: (lines) => ipcRenderer.invoke('mark:session-summary', lines),

    undoHistory: () => ipcRenderer.invoke('mark:undo-history'),
    confirmResolve: (accepted) => ipcRenderer.invoke('mark:confirm-resolve', accepted),

    pluginsList: () => ipcRenderer.invoke('mark:plugins-list'),
    pluginToggle: (name, enabled) => ipcRenderer.invoke('mark:plugin-toggle', name, enabled),
    pluginSettings: () => ipcRenderer.invoke('mark:plugin-settings'),
    pluginSettingsSave: (ns, values) => ipcRenderer.invoke('mark:plugin-settings-save', ns, values),
    pluginSettingsAction: (ns, values) => ipcRenderer.invoke('mark:plugin-settings-action', ns, values),
    openPluginsFolder: () => ipcRenderer.invoke('mark:open-plugins-folder'),

    news: (query) => ipcRenderer.invoke('mark:news', query),
    metrics: () => ipcRenderer.invoke('mark:metrics'),
    sysmonCheck: () => ipcRenderer.invoke('mark:sysmon-check'),
    bgCheck: () => ipcRenderer.invoke('mark:bg-check'),
    proactive: (payload) => ipcRenderer.invoke('mark:proactive', payload),

    clipboardWatch: (on) => ipcRenderer.invoke('mark:clipboard-watch', on),
    clipboardWrite: (text) => ipcRenderer.invoke('mark:clipboard-write', text),
    autostartGet: () => ipcRenderer.invoke('mark:autostart-get'),
    autostartSet: (enabled) => ipcRenderer.invoke('mark:autostart-set', enabled),
    desktopShortcut: () => ipcRenderer.invoke('mark:desktop-shortcut'),
    setCurrentFile: (file) => ipcRenderer.invoke('mark:set-current-file', file),
    shutdown: () => ipcRenderer.invoke('mark:shutdown'),

    pttStart: () => ipcRenderer.invoke('mark:ptt-start'),
    pttStop: () => ipcRenderer.invoke('mark:ptt-stop'),

    remoteKey: () => ipcRenderer.invoke('mark:remote-key'),
    remoteNewKey: () => ipcRenderer.invoke('mark:remote-new-key'),
    remoteBroadcast: (msg) => ipcRenderer.invoke('mark:remote-broadcast', msg),

    // Every main → renderer event arrives here as { type, ...payload }.
    // Returns an unsubscribe.
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('mark:event', listener);
      return () => ipcRenderer.removeListener('mark:event', listener);
    },
  },

  // Pilot: reading the screen and driving it. Kept as its own namespace so the
  // privileged surface is obvious at a glance in a review.
  pilot: {
    available: () => ipcRenderer.invoke('pilot:available'),
    foreground: () => ipcRenderer.invoke('pilot:foreground'),
    tree: (options) => ipcRenderer.invoke('pilot:tree', options),
    windows: () => ipcRenderer.invoke('pilot:windows'),
    elementAt: (x, y) => ipcRenderer.invoke('pilot:element-at', { x, y }),
    pollInput: () => ipcRenderer.invoke('pilot:poll-input'),
    act: (action, options) => ipcRenderer.invoke('pilot:act', action, options),
    capture: (options) => ipcRenderer.invoke('pilot:capture', options),
    settle: (options) => ipcRenderer.invoke('pilot:settle', options),
    review: (steps) => ipcRenderer.invoke('pilot:review', steps),

    stop: () => ipcRenderer.invoke('pilot:stop'),
    clearStop: () => ipcRenderer.invoke('pilot:clear-stop'),
    stopState: () => ipcRenderer.invoke('pilot:stop-state'),

    workflows: () => ipcRenderer.invoke('pilot:workflows'),
    saveWorkflow: (workflow) => ipcRenderer.invoke('pilot:save-workflow', workflow),
    deleteWorkflow: (id) => ipcRenderer.invoke('pilot:delete-workflow', id),
    findWorkflow: (nameOrId) => ipcRenderer.invoke('pilot:find-workflow', nameOrId),
    recordRun: (id, summary) => ipcRenderer.invoke('pilot:record-run', id, summary),

    journal: (limit) => ipcRenderer.invoke('pilot:journal', limit),
    undo: (entryId) => ipcRenderer.invoke('pilot:undo', entryId),
    undoRun: (runId) => ipcRenderer.invoke('pilot:undo-run', runId),

    // The stop shortcut fires whatever has focus, so the renderer has to be
    // told rather than asked. Returns an unsubscribe.
    onStopped: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('pilot:stopped', listener);
      return () => ipcRenderer.removeListener('pilot:stopped', listener);
    },
  },
});
