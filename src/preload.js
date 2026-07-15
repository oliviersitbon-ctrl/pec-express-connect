/**
 * Omnicab Desktop v1.3.0 - Preload Script
 * Bridge securise entre le main process et le renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] === PRELOAD v1.3.0 CHARGE ===');
console.log('[PRELOAD] contextBridge disponible:', !!contextBridge);
console.log('[PRELOAD] ipcRenderer disponible:', !!ipcRenderer);

contextBridge.exposeInMainWorld('cabflow', {
  // Configuration
  getConfig: () => {
    console.log('[PRELOAD] IPC invoke: get-config');
    return ipcRenderer.invoke('get-config');
  },
  setConfig: (key, value) => {
    console.log('[PRELOAD] IPC invoke: set-config', key, value);
    return ipcRenderer.invoke('set-config', key, value);
  },

  // Mode d'extraction (pdf / logos / auto)
  getExtractionMode: () => ipcRenderer.invoke('get-extraction-mode'),
  setExtractionMode: (mode) => ipcRenderer.invoke('set-extraction-mode', mode),

  // Overlay "Lancer la PEC" - clic du bouton flottant
  lancerPec: () => ipcRenderer.invoke('overlay-lancer-pec'),
  onOverlayInfo: (cb) => ipcRenderer.on('overlay-info', (e, data) => cb(data)),

  // Status
  getStatus: () => {
    console.log('[PRELOAD] IPC invoke: get-status');
    return ipcRenderer.invoke('get-status');
  },

  // Actions
  reinstallPrinter: () => {
    console.log('[PRELOAD] IPC invoke: reinstall-printer');
    return ipcRenderer.invoke('reinstall-printer');
  },
  setDefaultPrinter: () => {
    console.log('[PRELOAD] IPC invoke: set-default-printer');
    return ipcRenderer.invoke('set-default-printer');
  },
  getPrinterStatus: () => {
    console.log('[PRELOAD] IPC invoke: get-printer-status');
    return ipcRenderer.invoke('get-printer-status');
  },
  testPrint: () => {
    console.log('[PRELOAD] IPC invoke: test-print');
    return ipcRenderer.invoke('test-print');
  },

  // Version
  getVersion: () => {
    console.log('[PRELOAD] IPC invoke: get-version');
    return ipcRenderer.invoke('get-version');
  },

  // Logs
  openLogsFolder: () => {
    console.log('[PRELOAD] IPC invoke: open-logs-folder');
    return ipcRenderer.invoke('open-logs-folder');
  },
  readLogs: () => {
    console.log('[PRELOAD] IPC invoke: read-logs');
    return ipcRenderer.invoke('read-logs');
  },

  onSetupProgress: (callback) => {
    ipcRenderer.on('setup-progress', (event, message) => callback(message));
  },

  // Loader (CabFlow print flow)
  onLoaderReset: (callback) => {
    ipcRenderer.on('loader-reset', () => callback());
  },
  onLoaderPatientInfo: (callback) => {
    ipcRenderer.on('loader-patient-info', (event, data) => callback(data));
  },
  
  // Self-Installation
  performSelfInstall: () => {
    console.log('[PRELOAD] IPC invoke: perform-self-install');
    return ipcRenderer.invoke('perform-self-install');
  }
});

console.log('[PRELOAD] === window.cabflow expose avec succes ===');

// API dashboard PEC Express Connect (v1.0.15+)
contextBridge.exposeInMainWorld('logosConnectApi', {
  getStatus: () => ipcRenderer.invoke('lc-get-status'),
  reinstallDll: () => ipcRenderer.invoke('lc-reinstall-dll'),
  uninstallAll: () => ipcRenderer.invoke('lc-uninstall-all'),
  getLogs: (tab) => ipcRenderer.invoke('lc-get-logs', tab),
  onStatusChanged: (cb) => ipcRenderer.on('lc-status-changed', (e, status) => cb(status))
});
