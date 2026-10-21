const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MAX_FILE_SIZE, copyBook, isWithinFolder, restoreStagedLibraryBook, scanFolder, stageLibraryBookForDeletion, verifyStagedLibraryBook } = require('./library-storage.cjs');

const APP_SCHEME = 'libra';
const ONLINE_PARTITION = 'persist:libra-online-library';
const CHROME_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const WEB_ROOT = path.resolve(__dirname, '..', 'ui-prototype');
const APP_ICON = path.resolve(__dirname, '..', 'assets', 'yomi-reader.ico');
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'desktop-settings.json');
const LOG_FILE = () => path.join(app.getPath('userData'), 'libra-reader.log');
let mainWindow;
let scanTimer;
let lastSeen = new Map();
let stableCounts = new Map();
let notified = new Set();
const selectedImportFolders = new Set();
const pendingLibraryFolders = new Set();

function log(message) {
  try { fs.appendFileSync(LOG_FILE(), `${new Date().toISOString()} ${message}\n`, 'utf8'); }
  catch { /* Diagnostics must never prevent the app from opening. */ }
}

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8')); }
  catch { return {}; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE()), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
function getDownloadFolder() { return readConfig().downloadFolder || app.getPath('downloads'); }
function getLibraryFolder() { return readConfig().libraryFolder || path.join(app.getPath('userData'), 'Library'); }
function sendToApp(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function safeFilePathFromAppUrl(rawUrl) {
  const url = new URL(rawUrl);
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(WEB_ROOT, relativePath);
  if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}${path.sep}`)) return null;
  return file;
}
function normalizeWebUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function attachOnlineWindowRules(win) {
  const wc = win.webContents;
  wc.setUserAgent(CHROME_USER_AGENT);
  wc.setWindowOpenHandler(({ url }) => {
    const safeUrl = normalizeWebUrl(url);
    if (!safeUrl) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1180,
        height: 820,
        minWidth: 760,
        minHeight: 560,
        title: '在线书库 · Libra Reader',
        icon: APP_ICON,
        backgroundColor: '#090a0c',
        autoHideMenuBar: true,
        webPreferences: {
          partition: ONLINE_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false
        }
      }
    };
  });
  wc.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_SCHEME}://`)) return;
    if (!normalizeWebUrl(url)) event.preventDefault();
  });
  wc.on('did-create-window', child => attachOnlineWindowRules(child));
  wc.on('did-navigate', (_event, url, httpResponseCode) => {
    log(`NAVIGATED ${httpResponseCode || ''} ${url}`);
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) log(`LOAD_FAILED ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  wc.on('render-process-gone', (_event, details) => {
    log(`RENDERER_GONE ${JSON.stringify(details)}`);
  });
  win.on('page-title-updated', (event, title) => {
    log(`PAGE_TITLE ${title}`);
    if (!title.includes('Libra Reader')) win.setTitle(`${title} · Libra Reader`);
  });
}

function createOnlineWindow(rawUrl) {
  const safeUrl = normalizeWebUrl(rawUrl);
  if (!safeUrl) throw new Error('只支持 HTTPS 书库网址');
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: '在线书库 · Libra Reader',
    icon: APP_ICON,
    backgroundColor: '#090a0c',
    autoHideMenuBar: true,
    webPreferences: {
      partition: ONLINE_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });
  attachOnlineWindowRules(win);
  win.loadURL(safeUrl).catch(error => log(`LOAD_ERROR ${safeUrl} ${error.message}`));
  return win;
}

function configureOnlineSession() {
  const onlineSession = session.fromPartition(ONLINE_PARTITION);
  onlineSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    callback({ requestHeaders: details.requestHeaders });
  });
  onlineSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  onlineSession.on('will-download', (_event, item) => {
    const folder = getDownloadFolder();
    fs.mkdirSync(folder, { recursive: true });
    const original = path.basename(item.getFilename() || 'download');
    let destination = path.join(folder, original);
    if (fs.existsSync(destination)) {
      const ext = path.extname(original), stem = path.basename(original, ext);
      destination = path.join(folder, `${stem} (${Date.now()})${ext}`);
    }
    item.setSavePath(destination);
    const id = `dl-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const publish = (status, progress, message) => sendToApp('desktop-download', {
      id, name: path.basename(destination), path: destination, status, progress, message,
      createdAt: Date.now(), ext: path.extname(destination).slice(1).toLowerCase()
    });
    publish('active', 0, '正在下载');
    item.on('updated', () => {
      const total = item.getTotalBytes();
      const progress = total > 0 ? Math.floor(item.getReceivedBytes() / total * 100) : 0;
      publish('active', progress, '正在下载');
    });
    item.once('done', (_e, state) => {
      if (state === 'completed') publish('waiting', 100, '下载完成，等待自动导入');
      else publish('error', 0, state === 'cancelled' ? '下载已取消' : '下载失败');
    });
  });
}

async function scanFolderOnce() {
  const folder = getDownloadFolder();
  let files;
  try { files = await fs.promises.readdir(folder, { withFileTypes: true }); }
  catch { return; }
  const allowed = new Set(['epub', 'pdf', 'txt']);
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (!allowed.has(ext) || /\.(crdownload|part|tmp)$/i.test(entry.name)) continue;
    const fullPath = path.join(folder, entry.name);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.size) continue;
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (lastSeen.get(fullPath) === signature) stableCounts.set(fullPath, (stableCounts.get(fullPath) || 0) + 1);
      else { lastSeen.set(fullPath, signature); stableCounts.set(fullPath, 0); }
      const stamp = `${fullPath}|${signature}`;
      if (stableCounts.get(fullPath) >= 2 && !notified.has(stamp)) {
        notified.add(stamp);
        sendToApp('desktop-book-file', {
          id: Buffer.from(stamp).toString('base64url'),
          name: entry.name,
          path: fullPath,
          size: stat.size,
          lastModified: stat.mtimeMs
        });
      }
    } catch { /* file may still be changing or may have been removed */ }
  }
}
async function startFolderMonitor() {
  if (scanTimer) clearInterval(scanTimer);
  lastSeen = new Map(); stableCounts = new Map(); notified = new Set();
  const folder = getDownloadFolder();
  try {
    const files = await fs.promises.readdir(folder, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !['epub', 'pdf', 'txt'].includes(path.extname(entry.name).slice(1).toLowerCase())) continue;
      const fullPath = path.join(folder, entry.name), stat = await fs.promises.stat(fullPath);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      lastSeen.set(fullPath, signature); stableCounts.set(fullPath, 3); notified.add(`${fullPath}|${signature}`);
    }
  } catch { /* folder may not exist yet */ }
  scanTimer = setInterval(scanFolderOnce, 1800);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#090a0c',
    title: 'Libra Reader',
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });
  attachOnlineWindowRules(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`${APP_SCHEME}://app/index.html`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  protocol.handle(APP_SCHEME, request => {
    const file = safeFilePathFromAppUrl(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  ipcMain.handle('desktop:choose-folder', async event => {
    if (event.sender !== mainWindow?.webContents) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    writeConfig({ downloadFolder: result.filePaths[0] });
    lastSeen.clear(); stableCounts.clear(); notified.clear();
    startFolderMonitor();
    return result.filePaths[0];
  });
  ipcMain.handle('desktop:open-online', (event, rawUrl) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无权打开在线书库');
    const win = createOnlineWindow(rawUrl);
    log(`OPEN_ONLINE ${win.webContents.getURL() || rawUrl}`);
    return true;
  });
  ipcMain.handle('desktop:get-folder', event => {
    if (event.sender !== mainWindow?.webContents) return null;
    return getDownloadFolder();
  });
  ipcMain.handle('desktop:choose-import-folder', async event => {
    if (event.sender !== mainWindow?.webContents) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = path.resolve(result.filePaths[0]); selectedImportFolders.add(folder); return folder;
  });
  ipcMain.handle('desktop:scan-import-folder', async (event, folder, extensions, minSizeBytes) => {
    if (event.sender !== mainWindow?.webContents || typeof folder !== 'string') return [];
    const root = path.resolve(folder);
    if (!selectedImportFolders.has(root)) return [];
    return scanFolder(root, extensions, minSizeBytes);
  });
  ipcMain.handle('desktop:read-import-file', async (event, filePath) => {
    if (event.sender !== mainWindow?.webContents || typeof filePath !== 'string') return null;
    const target = path.resolve(filePath);
    if (![...selectedImportFolders].some(folder => isWithinFolder(folder, target))) return null;
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) return null;
    return { name: path.basename(target), lastModified: stat.mtimeMs, bytes: await fs.promises.readFile(target) };
  });
  ipcMain.handle('desktop:get-library-folder', async event => {
    if (event.sender !== mainWindow?.webContents) return null;
    const folder = getLibraryFolder(); await fs.promises.mkdir(folder, { recursive: true }); return folder;
  });
  ipcMain.handle('desktop:choose-library-folder', async event => {
    if (event.sender !== mainWindow?.webContents) return null;
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = path.resolve(result.filePaths[0]); pendingLibraryFolders.add(folder); return folder;
  });
  ipcMain.handle('desktop:copy-book-path', async (event, sourcePath, name, hash, targetFolder) => {
    if (event.sender !== mainWindow?.webContents || typeof sourcePath !== 'string') return null;
    const destination = targetFolder ? path.resolve(targetFolder) : getLibraryFolder();
    if (destination !== path.resolve(getLibraryFolder()) && !pendingLibraryFolders.has(destination)) throw new Error('目标书库目录未经过选择');
    return copyBook({ sourcePath, name, hash, libraryFolder: destination });
  });
  ipcMain.handle('desktop:copy-book-bytes', async (event, bytes, name, hash, targetFolder) => {
    if (event.sender !== mainWindow?.webContents) return null;
    const destination = targetFolder ? path.resolve(targetFolder) : getLibraryFolder();
    if (destination !== path.resolve(getLibraryFolder()) && !pendingLibraryFolders.has(destination)) throw new Error('目标书库目录未经过选择');
    return copyBook({ bytes, name, hash, libraryFolder: destination });
  });
  ipcMain.handle('desktop:set-library-folder', async (event, folder) => {
    if (event.sender !== mainWindow?.webContents || typeof folder !== 'string') return null;
    const target = path.resolve(folder);
    if (!pendingLibraryFolders.has(target)) return null;
    await fs.promises.mkdir(target, { recursive: true });
    writeConfig({ libraryFolder: target }); pendingLibraryFolders.delete(target); return target;
  });
  ipcMain.handle('desktop:read-library-book', async (event, filePath) => {
    if (event.sender !== mainWindow?.webContents || typeof filePath !== 'string') return null;
    const folder = path.resolve(getLibraryFolder()), target = path.resolve(filePath);
    if (!isWithinFolder(folder, target)) return null;
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null;
    return { name: path.basename(target), lastModified: stat.mtimeMs, bytes: await fs.promises.readFile(target) };
  });
  ipcMain.handle('desktop:stage-library-book-delete', async (event, filePath, hash, ext) => {
    if (event.sender !== mainWindow?.webContents || typeof filePath !== 'string' || !/^[a-f0-9]{64}$/i.test(String(hash)) || !['epub', 'pdf', 'txt'].includes(String(ext).toLowerCase())) throw new Error('无权删除此图书文件');
    return stageLibraryBookForDeletion({ filePath, hash, ext, libraryFolder: getLibraryFolder() });
  });
  ipcMain.handle('desktop:restore-library-book-delete', async (event, stagedPath, originalPath) => {
    if (event.sender !== mainWindow?.webContents || typeof stagedPath !== 'string' || typeof originalPath !== 'string') throw new Error('无权恢复图书文件');
    return restoreStagedLibraryBook({ stagedPath, originalPath, libraryFolder: getLibraryFolder() });
  });
  ipcMain.handle('desktop:trash-staged-library-book', async (event, stagedPath) => {
    if (event.sender !== mainWindow?.webContents || typeof stagedPath !== 'string') throw new Error('无权回收此文件');
    const target = await verifyStagedLibraryBook(stagedPath, getLibraryFolder());
    await shell.trashItem(target); return true;
  });
  ipcMain.handle('desktop:read-book-file', async (event, filePath) => {
    if (event.sender !== mainWindow?.webContents || typeof filePath !== 'string') return null;
    const folder = path.resolve(getDownloadFolder()), target = path.resolve(filePath);
    if (!target.startsWith(`${folder}${path.sep}`)) return null;
    const stat = await fs.promises.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024 * 1024) return null;
    return { name: path.basename(target), lastModified: stat.mtimeMs, bytes: await fs.promises.readFile(target) };
  });

  configureOnlineSession();
  createMainWindow();
  mainWindow.webContents.once('did-finish-load', () => startFolderMonitor());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (scanTimer) clearInterval(scanTimer); });
