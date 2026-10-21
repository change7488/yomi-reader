const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('libraDesktop', {
  isDesktop: true,
  openOnline: url => ipcRenderer.invoke('desktop:open-online', url),
  chooseDownloadFolder: () => ipcRenderer.invoke('desktop:choose-folder'),
  getDownloadFolder: () => ipcRenderer.invoke('desktop:get-folder'),
  readBookFile: filePath => ipcRenderer.invoke('desktop:read-book-file', filePath),
  chooseImportFolder: () => ipcRenderer.invoke('desktop:choose-import-folder'),
  scanImportFolder: (folder, extensions, minSizeBytes) => ipcRenderer.invoke('desktop:scan-import-folder', folder, extensions, minSizeBytes),
  readImportFile: filePath => ipcRenderer.invoke('desktop:read-import-file', filePath),
  getLibraryFolder: () => ipcRenderer.invoke('desktop:get-library-folder'),
  chooseLibraryFolder: () => ipcRenderer.invoke('desktop:choose-library-folder'),
  setLibraryFolder: folder => ipcRenderer.invoke('desktop:set-library-folder', folder),
  copyBookFromPath: (sourcePath, name, hash, targetFolder) => ipcRenderer.invoke('desktop:copy-book-path', sourcePath, name, hash, targetFolder),
  copyBookBytes: (bytes, name, hash, targetFolder) => ipcRenderer.invoke('desktop:copy-book-bytes', bytes, name, hash, targetFolder),
  readLibraryBook: filePath => ipcRenderer.invoke('desktop:read-library-book', filePath),
  stageLibraryBook: (filePath, hash, ext) => ipcRenderer.invoke('desktop:stage-library-book-delete', filePath, hash, ext),
  restoreLibraryBook: (stagedPath, originalPath) => ipcRenderer.invoke('desktop:restore-library-book-delete', stagedPath, originalPath),
  trashStagedBook: stagedPath => ipcRenderer.invoke('desktop:trash-staged-library-book', stagedPath),
  getPathForFile: file => webUtils.getPathForFile(file),
  onBookFile: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop-book-file', handler);
    return () => ipcRenderer.removeListener('desktop-book-file', handler);
  },
  onDownload: callback => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('desktop-download', handler);
    return () => ipcRenderer.removeListener('desktop-download', handler);
  }
});
