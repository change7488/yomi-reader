import { createDatabaseQueries, openLibraryDatabase } from './storage/database.js';
import { initMobileShell } from './platform/mobile-shell.js';
import { androidFilePicker, chooseAndroidFolder, scanAndroidFolder, chooseAndroidFiles, chooseAndroidFonts, loadAndroidBook } from './platform/android-files.js';
import { pageDirectionForKey } from './reader/reading-interactions.js';
import { createReaderController } from './reader/reader-controller.js';
import { createLibraryView } from './library/library-view.js';
import { createDashboardView } from './home/dashboard-view.js';
import { createReadingAnalytics } from './analytics/reading-analytics.js';
import { createTaskView } from './downloads/task-view.js';
import { readBookMetadata, validateBookFile } from './reader/index.js';
import { createOnboarding } from './onboarding/onboarding.js';
import { addFolderLinks, deleteBookEntity, deleteFolderTree, removeFolderLinks } from './library-model.js';
import { NavigationHistoryService, ReadingPositionService } from './reader/position-services.js';
import { createFontManager } from './fonts/font-manager.js';

(() => {
  'use strict';
  const DB_NAME = 'libra-reader-preview';
  const ACCEPTED = new Set(['epub', 'pdf', 'txt']);
  let folderBrowserFiles = [];
  let nativeAndroidFolder = false;
  const $ = (id) => document.getElementById(id);
  const appearance = { palette: 'mint', mode: 'light', accent: '' };
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyAppearance() {
    document.body.dataset.palette = appearance.palette;
    const light = appearance.mode === 'light' || (appearance.mode === 'system' && !systemDark.matches);
    document.body.classList.toggle('light-mode', light);
    if (appearance.accent) document.body.style.setProperty('--accent-strong', appearance.accent);
    else document.body.style.removeProperty('--accent-strong');
    document.querySelectorAll('[data-palette-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.paletteChoice === appearance.palette)));
    document.querySelectorAll('[data-mode-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.modeChoice === appearance.mode)));
    if ($('accentColorInput')) $('accentColorInput').value = appearance.accent || ({mint:'#287f62',lilac:'#775b8e',graphite:'#426e65'}[appearance.palette]);
  }
  function saveAppearance() { localStorage.setItem('yomi-appearance', JSON.stringify(appearance)); applyAppearance(); }
  function initAppearance() {
    try { const saved = JSON.parse(localStorage.getItem('yomi-appearance') || 'null'); if (saved && typeof saved === 'object') { if (['mint','lilac','graphite'].includes(saved.palette)) appearance.palette = saved.palette; if (['light','dark','system'].includes(saved.mode)) appearance.mode = saved.mode; if (/^#[0-9a-fA-F]{6}$/.test(saved.accent || '')) appearance.accent = saved.accent; } else if (localStorage.getItem('libra-theme') === 'dark') appearance.mode = 'dark'; } catch (_) {}
    applyAppearance();
    systemDark.addEventListener('change', () => { if (appearance.mode === 'system') applyAppearance(); });
  }
  function initCoverDensity() {
    const saved = Number(localStorage.getItem('yomi-cover-width'));
    const input = $('coverDensityRange');
    input.value = Number.isFinite(saved) && saved >= 140 && saved <= 280 ? saved : 196;
    const update = () => { document.body.style.setProperty('--cover-width', `${input.value}px`); $('coverDensityValue').textContent = input.value <= 168 ? '紧凑' : input.value >= 240 ? '大封面' : '舒适'; };
    input.addEventListener('input', update);
    input.addEventListener('change', () => localStorage.setItem('yomi-cover-width', input.value));
    update();
  }
  const state = { db: null, books: [], tasks: [], folders: [], folderBooks: [], readingStates: new Map(), selectedBooks: new Set(), collapsedFolders: new Set(), route: 'all', filter: 'all', query: '', sortRecent: true, folder: null, scanning: false, folderImportPath: '', folderImportItems: [], libraryFolder: '', contextBookId: '', contextFolderId: '', folderEditorParentId: null, pendingAddBookIds: [], editingFolderId: '', readerSize: 17, readerBook: null, readerChapters: [], readerChapterIndex: 0, readerImages: [], readerObjectUrls: [], activeImageIndex: 0, progressTimer: null, speechActive: false, wheelDelta: 0, wheelTimer: null, turnTimer: null, pendingNoteQuote: '', readingAnalytics: { days: {}, books: {} }, readerLastActivity: 0, analyticsLastTick: Date.now(), analyticsTimer: null, positionService: null, navigationService: new NavigationHistoryService(), activeReaderSessionId: '', restoringPosition: false, pendingSeekValue: null, undoNoticeTimer: null, readerSearchResults: [], readerSearchTimer: null };

  const onboarding = createOnboarding({
    navigateHome: () => navigate('home'),
    hasBooks: () => state.books.length > 0,
    getReaderFormat: () => state.readerBook?.ext || null
  });

  const { dbRequest, all, put } = createDatabaseQueries(() => state.db);
  const fontManager = createFontManager({ all, put, dbRequest, toast });
  const nativeFontPicker = () => androidFilePicker() ? chooseAndroidFonts() : null;
  function saveFolderLinks(nextLinks) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction('folderBooks', 'readwrite'), store = tx.objectStore('folderBooks');
      const request = store.getAll();
      request.onsuccess = () => {
        const nextByKey = new Map(nextLinks.map(link => [`${link.folderId}\u0000${link.bookId}`, link]));
        for (const old of request.result) if (!nextByKey.has(`${old.folderId}\u0000${old.bookId}`)) store.delete([old.folderId, old.bookId]);
        const oldKeys = new Set(request.result.map(link => `${link.folderId}\u0000${link.bookId}`));
        for (const link of nextLinks) if (!oldKeys.has(`${link.folderId}\u0000${link.bookId}`)) store.put(link);
      };
      tx.oncomplete = () => { state.folderBooks = nextLinks; renderFolders(); renderBooks(); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('文件夹关系保存失败'));
    });
  }
  function getFolderBooks(folderId) { return state.folderBooks.filter(link => link.folderId === folderId); }
  function folderBookCount(folderId) { return getFolderBooks(folderId).length; }
  function getFolderDescendants(folderId) {
    const ids = new Set([folderId]); let changed = true;
    while (changed) { changed = false; for (const folder of state.folders) if (ids.has(folder.parentId) && !ids.has(folder.id)) { ids.add(folder.id); changed = true; } }
    return ids;
  }
  function folderById(id) { return state.folders.find(folder => folder.id === id); }
  function folderRouteId() { return state.route.startsWith('folder:') ? state.route.slice(7) : ''; }
  function visibleBookById(id) { return state.books.find(book => book.id === id); }
  function openFolderEditor(folderId = '', parentId = null, addBookIds = []) {
    state.editingFolderId = folderId; state.folderEditorParentId = parentId; state.pendingAddBookIds = [...addBookIds];
    const folder = folderById(folderId); $('folderEditorTitle').textContent = folder ? '编辑文件夹' : '新建文件夹';
    $('folderNameInput').value = folder?.name || ''; $('folderIconInput').value = folder?.icon || '📚'; $('folderColorInput').value = folder?.color || '#61a77d';
    const forbidden = folderId ? getFolderDescendants(folderId) : new Set();
    $('folderParentSelect').innerHTML = `<option value="">无（顶级文件夹）</option>` + state.folders.filter(item => !forbidden.has(item.id)).map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    $('folderParentSelect').value = folder?.parentId || parentId || '';
    $('folderEditorModal').classList.remove('hidden'); $('folderNameInput').focus();
  }
  function sortedFolders(parentId = null) { return state.folders.filter(folder => (folder.parentId || null) === parentId).sort((a,b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name, 'zh-CN')); }
  function renderFolders() {
    const nav = $('folderNavTree'); if (!nav) return;
    const draw = (parentId, depth = 0) => sortedFolders(parentId).map(folder => {
      const children = sortedFolders(folder.id), collapsed = state.collapsedFolders.has(folder.id), active = state.route === `folder:${folder.id}`;
      return `<div class="folder-nav-node" data-folder-node="${esc(folder.id)}"><div class="folder-nav-row ${active ? 'active' : ''}" style="--folder-depth:${depth}"><button class="folder-expand ${children.length ? '' : 'is-empty'}" data-folder-expand="${esc(folder.id)}" aria-label="${collapsed ? '展开' : '收起'}">${children.length ? (collapsed ? '›' : '⌄') : ''}</button><button class="folder-nav-link" data-folder-nav="${esc(folder.id)}" title="${esc(folder.name)}"><span class="folder-nav-icon" style="--folder-color:${esc(folder.color || '#61a77d')}"><i aria-hidden="true"></i><b>${esc(folder.icon || '📚')}</b></span><span>${esc(folder.name)}</span><small>${folderBookCount(folder.id)}</small></button><button class="folder-nav-more" data-folder-menu="${esc(folder.id)}" title="文件夹选项">···</button></div>${children.length && !collapsed ? `<div class="folder-nav-children">${draw(folder.id, depth + 1)}</div>` : ''}</div>`;
    }).join('');
    nav.innerHTML = draw(null) || '<div class="folder-nav-empty">还没有自定义文件夹</div>';
    nav.querySelectorAll('[data-folder-nav]').forEach(button => button.classList.toggle('active', state.route === `folder:${button.dataset.folderNav}`));
  }
  function updateSelectionToolbar() {
    const ids = [...state.selectedBooks].filter(id => visibleBookById(id)); state.selectedBooks = new Set(ids);
    $('bulkFolderToolbar').classList.toggle('hidden', !ids.length);
    $('selectedBooksCount').textContent = `已选 ${ids.length} 本`;
    $('bulkRemoveFolderBtn').classList.toggle('hidden', !folderRouteId());
  }
  function showConfirm(title, text, accept = '确认', danger = true) {
    return new Promise(resolve => {
      const modal = $('appConfirmModal'), button = $('appConfirmAccept'); let done = false;
      $('appConfirmTitle').textContent = title; $('appConfirmText').textContent = text; button.textContent = accept; button.classList.toggle('danger-confirm', danger);
      modal.classList.remove('hidden');
      const finish = value => { if (done) return; done = true; modal.classList.add('hidden'); button.onclick = null; $('appConfirmCancel').onclick = $('appConfirmClose').onclick = null; modal.onclick = null; resolve(value); };
      button.onclick = () => finish(true); $('appConfirmCancel').onclick = $('appConfirmClose').onclick = () => finish(false); modal.onclick = event => { if (event.target === modal) finish(false); };
    });
  }
  function esc(s = '') { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function toast(message, kind = '') {
    const node = document.createElement('div'); node.className = `toast ${kind}`; node.textContent = message; $('toastStack').append(node);
    setTimeout(() => node.remove(), 4200);
  }
  const extension = (name) => (name.split('.').pop() || '').toLowerCase();
  const fileId = (file) => `${file.name.toLowerCase()}-${file.size}-${file.lastModified}`;
  async function hashFile(file) {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  async function validate(file) {
    const ext = extension(file.name);
    if (!ACCEPTED.has(ext)) throw new Error('仅支持 EPUB、PDF 和 TXT');
    if (!file.size) throw new Error('文件为空');
    try { await validateBookFile(file, ext); }
    catch (e) { throw new Error(`${ext.toUpperCase()} 文件无效：${e.message}`); }
    return ext;
  }
  function filenameTitle(name) { return name.replace(/\.(epub|pdf|txt)$/i, '').replace(/[._]+/g, ' ').trim() || name; }
  function svgCover(title, author, color = '#a8d7bf') {
    const safe = esc(title).slice(0, 70), initials = esc((title || 'L').slice(0, 1));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 670"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="${color}"/><stop offset="1" stop-color="#172720"/></linearGradient><radialGradient id="r"><stop stop-color="#efffe9" stop-opacity=".48"/><stop offset="1" stop-color="#efffe9" stop-opacity="0"/></radialGradient></defs><rect width="480" height="670" fill="url(#g)"/><circle cx="360" cy="180" r="230" fill="url(#r)"/><path d="M0 470Q180 350 480 500V670H0Z" fill="#07110d" fill-opacity=".45"/><text x="42" y="75" fill="#ecf5ee" font-size="17" font-family="sans-serif" letter-spacing="5">LIBRA  /  READER</text><text x="44" y="390" fill="#f3f3e9" font-size="190" font-family="serif" opacity=".2">${initials}</text><foreignObject x="42" y="430" width="390" height="125"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#f4f5eb;font-family:serif;font-size:38px;line-height:1.2;word-break:break-word">${safe}</div></foreignObject><text x="45" y="610" fill="#d3dfd5" font-size="18" font-family="sans-serif">${esc(author || 'LOCAL EDITION').slice(0,45)}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  async function addFile(file, source = '本地导入', nativeSourcePath = '', options = {}) {
    const ext = await validate(file), hash = await hashFile(file);
    if (!options.allowDuplicate && state.books.some(book => book.hash === hash)) { if (!options.quiet) toast(`《${filenameTitle(file.name)}》已在书架中，跳过重复文件。`); return null; }
    const now = Date.now(), id = `${hash.slice(0, 18)}-${crypto.randomUUID()}`;
    let meta = { title: filenameTitle(file.name), author: '', coverBlob: null };
    if (ext === 'epub') {
      try { const epub = await readBookMetadata(file, ext); meta = { ...meta, ...epub, title: epub.title || meta.title, author: epub.author || '' }; }
      catch (e) { if (file.size < 5000) throw e; toast(`已导入文件名；读取 EPUB 书目信息失败：${e.message}`, 'error'); }
    }
    let nativePath = '';
    if (window.libraDesktop?.isDesktop) {
      let filePath = nativeSourcePath;
      if (!filePath) { try { filePath = window.libraDesktop.getPathForFile(file); } catch { filePath = ''; } }
      const stored = filePath
        ? await window.libraDesktop.copyBookFromPath(filePath, file.name, hash)
        : await window.libraDesktop.copyBookBytes(new Uint8Array(await file.arrayBuffer()), file.name, hash);
      if (!stored?.path) throw new Error('无法复制到软件书库文件夹');
      nativePath = stored.path;
    }
    const book = { id, name: file.name, title: meta.title, author: meta.author, ext, file, nativePath, storageMode: nativePath ? 'managed' : 'indexeddb', coverBlob: meta.coverBlob, hash, progress: 0, favorite: !!options.favorite, lastRead: 0, addedAt: now, source };
    await put('books', book); state.books.push(book);
    await addTask({ id: `task-${id}`, name: file.name, ext, status: 'done', progress: 100, message: '已导入本地图书馆', createdAt: now, imported: true });
    render(); onboarding.onBookImported(); if (!options.quiet) toast(`《${book.title}》已添加到书架。`); return book;
  }
  async function importFromPicker() {
    if (!androidFilePicker()) {
      if (window.Capacitor?.isNativePlatform?.()) toast('当前安装包缺少原生多文件选择功能，请安装新版 APK。', 'error');
      else $('fileInput').click();
      return;
    }
    try {
      const entries = await chooseAndroidFiles();
      if (!entries.length) return;
      let imported = 0, skipped = 0, failed = 0;
      for (const entry of entries) {
        try {
          const book = await addFile(await loadAndroidBook(entry), '本地导入', '', { quiet: true });
          if (book) imported++; else skipped++;
        } catch (error) {
          failed++;
          console.warn('Android 文件导入失败', entry.name, error);
          toast(`${entry.name}：${error.message || '导入失败'}`, 'error');
        }
      }
      render();
      toast(`批量导入：成功 ${imported} 本，重复跳过 ${skipped} 本，失败 ${failed} 本。`);
    } catch (error) { toast(`打开手机文件选择器失败：${error.message || error}`, 'error'); }
  }
  async function importFiles(files, source) {
    const list = [...files];
    for (const file of list) {
      try { await addFile(file, source); }
      catch (e) { await addTask({ id: `task-${Date.now()}-${Math.random()}`, name: file.name, ext: extension(file.name), status: 'error', progress: 0, message: e.message || '导入失败', createdAt: Date.now(), imported: false }); toast(`${file.name}：${e.message || '导入失败'}`, 'error'); }
    }
    render();
  }
  function formatFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  function renderFolderImportFiles() {
    const list = $('folderFileList'), items = state.folderImportItems;
    $('folderScanSummary').textContent = items.length
      ? `找到 ${items.length} 个匹配文件，已默认全选。取消勾选可跳过；扫描会包含所选文件夹的子目录。`
      : '没有找到符合格式和最小大小条件的文件。';
    list.innerHTML = items.map((item, index) => `<label class="folder-file-row"><input type="checkbox" data-import-index="${index}" ${item.selected ? 'checked' : ''}><span class="folder-file-type">${esc(item.ext.toUpperCase())}</span><span class="folder-file-name"><b>${esc(item.name)}</b><small>${esc(item.relativePath)}</small></span><span class="folder-file-size">${formatFileSize(item.size)}</span></label>`).join('') || '<div class="folder-file-empty">没有匹配文件。</div>';
    const selected = items.filter(item => item.selected).length;
    $('folderSelectAll').checked = !!items.length && selected === items.length;
    $('folderSelectAll').indeterminate = selected > 0 && selected < items.length;
    $('folderImportStart').disabled = selected === 0;
    $('folderImportStart').textContent = `导入选中文件（${selected}）`;
  }
  async function scanImportFolder() {
    if (!state.folderImportPath) { toast('请先选择要扫描的文件夹。'); return; }
    const formats = [...document.querySelectorAll('.folder-format-list input:checked')].map(input => input.value);
    if (!formats.length) { toast('至少选择一种文件格式。'); return; }
    const button = $('folderScanBtn'); button.disabled = true; button.textContent = '正在扫描…';
    try {
      const minBytes = Math.max(0, Number($('folderMinSize').value) || 0) * 1024;
      const matches = window.libraDesktop?.isDesktop
        ? await window.libraDesktop.scanImportFolder(state.folderImportPath, formats, minBytes)
        : nativeAndroidFolder
          ? await scanAndroidFolder(formats, minBytes)
          : folderBrowserFiles.filter(file => formats.includes(extension(file.name)) && file.size >= minBytes).map(file => ({
              name: file.name, ext: extension(file.name), size: file.size,
              relativePath: file.webkitRelativePath || file.name, browserIndex: folderBrowserFiles.indexOf(file)
            }));
      state.folderImportItems = matches.map(item => ({ ...item, selected: true }));
      renderFolderImportFiles();
    } catch (error) { toast(`扫描文件夹失败：${error.message || error}`, 'error'); }
    finally { button.disabled = false; button.textContent = '扫描匹配文件'; }
  }
  async function importFolderSelection() {
    const selected = state.folderImportItems.filter(item => item.selected);
    if (!selected.length) return;
    const button = $('folderImportStart'); button.disabled = true;
    let imported = 0, skipped = 0, failed = [];
    for (let index = 0; index < selected.length; index++) {
      const item = selected[index]; button.textContent = `正在导入 ${index + 1}/${selected.length}`;
      try {
        let file;
        if (window.libraDesktop?.isDesktop) {
          const result = await window.libraDesktop.readImportFile(item.path);
          if (!result?.bytes) throw new Error('无法读取文件，可能已被移动或删除');
          file = new File([result.bytes], result.name, { lastModified: result.lastModified });
        } else if (nativeAndroidFolder) file = await loadAndroidBook(item);
        else file = folderBrowserFiles[item.browserIndex];
        if (!file) throw new Error('所选文件已不可用，请重新选择文件夹');
        const book = await addFile(file, '文件夹导入', item.path || '', { quiet: true, favorite: $('folderImportFavorite').checked, allowDuplicate: $('allowDuplicateImport').checked });
        if (book) imported++; else skipped++;
      } catch (error) { failed.push(`${item.name}：${error.message || '导入失败'}`); }
    }
    button.textContent = '导入选中文件';
    $('folderImportModal').classList.add('hidden');
    if (failed.length) toast(`批量导入完成：成功 ${imported} 本，重复跳过 ${skipped} 本，失败 ${failed.length} 本。${failed[0]}`, 'error');
    else toast(`批量导入完成：成功 ${imported} 本，重复跳过 ${skipped} 本。`);
    render();
  }
  async function migrateLibraryFolder() {
    if (!window.libraDesktop?.isDesktop) { toast('自定义磁盘书库位置需要 Windows 桌面版。'); return; }
    try {
      const destination = await window.libraDesktop.chooseLibraryFolder(); if (!destination) return;
      if (destination === state.libraryFolder) { toast('所选路径就是当前书库位置。'); return; }
      const books = [...state.books];
      if (!confirm(`将 ${books.length} 本书复制到新路径，并更新软件书库位置吗？迁移成功后原文件夹会保留作为备份。`)) return;
      const button = $('chooseLibraryPathBtn'); button.disabled = true;
      const migrated = [];
      for (let index = 0; index < books.length; index++) {
        const book = books[index]; button.textContent = `迁移中 ${index + 1}/${books.length}`;
        let result;
        if (book.nativePath) result = await window.libraDesktop.copyBookFromPath(book.nativePath, book.name, book.hash, destination);
        else if (book.file) result = await window.libraDesktop.copyBookBytes(new Uint8Array(await book.file.arrayBuffer()), book.name, book.hash, destination);
        else throw new Error(`《${book.title}》没有可迁移的本地文件`);
        if (!result?.path) throw new Error(`《${book.title}》复制失败`);
        migrated.push([book, result.path]);
      }
      const active = await window.libraDesktop.setLibraryFolder(destination);
      if (!active) throw new Error('无法切换书库目录');
      for (const [book, filePath] of migrated) { book.nativePath = filePath; await put('books', book); }
      state.libraryFolder = active; $('libraryPathText').textContent = active;
      toast(`书库路径已更新，${migrated.length} 本书已迁移。原文件夹保留为备份。`);
    } catch (error) { toast(`迁移失败：${error.message || error}`, 'error'); }
    finally { const button = $('chooseLibraryPathBtn'); button.disabled = false; button.textContent = '更改路径并迁移'; }
  }
  async function addTask(task) { await put('tasks', task); const i = state.tasks.findIndex(x => x.id === task.id); if (i >= 0) state.tasks[i] = task; else state.tasks.unshift(task); }
  async function handleDesktopBookFile(payload) {
    let task = state.tasks.find(x => x.nativePath === payload.path);
    if (!task) task = { id: `desktop-${payload.id}`, name: payload.name, ext: extension(payload.name), status: 'waiting', progress: 100, message: '下载完成，等待导入', createdAt: Date.now(), imported: false, nativePath: payload.path };
    else { task.name = payload.name; task.status = 'waiting'; task.progress = 100; task.message = '下载完成，等待导入'; }
    await addTask(task); render();
    const auto = await dbRequest('settings', 'readonly', s => s.get('autoImport'));
    if (auto?.value !== false) await importDesktopTask(task.id);
  }
  async function importDesktopTask(taskId) {
    const task = state.tasks.find(x => x.id === taskId); if (!task?.nativePath || !window.libraDesktop) return;
    try {
      const result = await window.libraDesktop.readBookFile(task.nativePath);
      if (!result) throw new Error('无法读取该下载文件');
      const file = new File([result.bytes], result.name, { lastModified: result.lastModified });
      const added = await addFile(file, '桌面下载监控', task.nativePath);
      if (!added) { task.status = 'done'; task.message = '书架已有相同文件，未重复导入'; task.imported = false; await addTask(task); }
      else { await dbRequest('tasks', 'readwrite', s => s.delete(taskId)); state.tasks = state.tasks.filter(x => x.id !== taskId); }
      render();
    } catch (e) { task.status = 'error'; task.message = e.message || '自动导入失败'; await addTask(task); render(); toast(`${task.name}：${task.message}`, 'error'); }
  }
  async function handleDesktopDownload(payload) {
    const task = state.tasks.find(x => x.nativeDownloadId === payload.id) || { id: `download-${payload.id}`, nativeDownloadId: payload.id, nativePath: payload.path, name: payload.name, ext: payload.ext, createdAt: payload.createdAt, imported: false };
    Object.assign(task, { name: payload.name, ext: payload.ext, status: payload.status, progress: payload.progress, message: payload.message, nativePath: payload.path });
    await addTask(task); render();
  }

  // Feature factories share existing app services without duplicating state.
  const { booksForView, coverSrc, renderBooks } = createLibraryView({ state, $, esc, svgCover, folderRouteId, getFolderBooks, folderById, updateSelectionToolbar });
  const { installAnalyticsSection, renderReadingAnalytics, markReaderActivity, trackActiveReading, recordPageTurn } = createReadingAnalytics({ state, $, esc, put });
  const { renderDashboard } = createDashboardView({ state, $, esc, coverSrc, navigate, renderReadingAnalytics });
  const { renderTasks } = createTaskView({ state, $, esc });
  // The same reader controller drives Electron and Android WebView.
  const { applyReaderStyle, reflowReaderPreservingPosition, installReaderControls, moveReaderPage, toggleReaderFullscreen, showReaderImage, persistReaderPosition, navigateReaderBack, navigateReaderForward, openBook, closeReader, bindReaderEvents } = createReaderController({ state, $, esc, toast, put, onboarding, renderDashboard, markReaderActivity, recordPageTurn, fontManager, chooseFontFiles: androidFilePicker() ? nativeFontPicker : null });

  function render() { renderFolders(); renderBooks(); renderTasks(); renderDashboard(); }
  function titleFor(route) { if (route.startsWith('folder:')) return folderById(route.slice(7))?.name || '我的文件夹'; return ({ all: '全部图书', favorites: '我的喜爱', history: '阅读记录' })[route] || '我的书库'; }
  function navigate(route) {
    if (route.startsWith('folder:') && !folderById(route.slice(7))) route = 'all';
    if (state.route !== route) state.selectedBooks.clear();
    state.route = route; document.querySelectorAll('.nav-item[data-view]').forEach(x => x.classList.toggle('active', x.dataset.view === route || (route === 'all' && x.dataset.view === 'all')));
    renderFolders();
    $('content').classList.toggle('hidden', ['online','public','downloads','local','settings'].includes(route));
    $('dashboard').classList.toggle('hidden', route !== 'home'); $('libraryView').classList.toggle('hidden', route === 'home');
    ['onlinePage','downloadsPage','localPage','settingsPage'].forEach(id => $(id).classList.add('hidden'));
    if (route === 'online' || route === 'public') $('onlinePage').classList.remove('hidden');
    if (route === 'downloads') $('downloadsPage').classList.remove('hidden');
    if (route === 'local') $('localPage').classList.remove('hidden');
    if (route === 'settings') $('settingsPage').classList.remove('hidden');
    $('pageTitle').innerHTML = `${esc(titleFor(route))}<span class="heading-dot">.</span>`;
    if (!['home','favorites','history'].includes(route) && !route.startsWith('folder:') && !['online','public','downloads','local','settings'].includes(route)) route = 'all';
    state.route = route; render();
    document.querySelectorAll('[data-mobile-view]').forEach(item => item.setAttribute('aria-current', String(item.dataset.mobileView === route ? 'page' : 'false')));
  }
  async function persistFolder(folder, bookIds = []) {
    const existing = folderById(folder.id), next = { ...folder, sortOrder: Number(folder.sortOrder ?? (existing?.sortOrder ?? state.folders.filter(item => (item.parentId || null) === (folder.parentId || null)).length)) };
    const links = addFolderLinks(state.folderBooks, [next.id], bookIds);
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(['folders', 'folderBooks'], 'readwrite'); tx.objectStore('folders').put(next);
      const store = tx.objectStore('folderBooks'), wanted = new Set(links.map(link => `${link.folderId}\u0000${link.bookId}`));
      for (const link of state.folderBooks) if (!wanted.has(`${link.folderId}\u0000${link.bookId}`)) store.delete([link.folderId, link.bookId]);
      for (const link of links) if (!state.folderBooks.some(old => old.folderId === link.folderId && old.bookId === link.bookId)) store.put(link);
      tx.oncomplete = () => { if (existing) state.folders = state.folders.map(item => item.id === next.id ? next : item); else state.folders.push(next); state.folderBooks = links; state.pendingAddBookIds = []; state.editingFolderId = ''; render(); resolve(next); };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('保存文件夹失败'));
    });
  }
  async function saveFolderEditor() {
    const name = $('folderNameInput').value.trim(); if (!name) { $('folderNameInput').focus(); toast('请填写文件夹名称。'); return; }
    const id = state.editingFolderId || `folder-${crypto.randomUUID()}`, existing = folderById(id);
    try { await persistFolder({ id, name, parentId: $('folderParentSelect').value || null, icon: $('folderIconInput').value.trim() || '📚', color: $('folderColorInput').value || '#61a77d', sortOrder: existing?.sortOrder }, state.pendingAddBookIds); $('folderEditorModal').classList.add('hidden'); toast(existing ? '文件夹已更新。' : '文件夹已创建。'); }
    catch (error) { toast(`保存文件夹失败：${error.message || error}`, 'error'); }
  }
  async function deleteFolder(folderId) {
    const folder = folderById(folderId); if (!folder) return;
    const ids = getFolderDescendants(folderId), childCount = ids.size - 1;
    const extra = childCount ? `\n\n该文件夹包含 ${childCount} 个子文件夹，也会一并删除。` : '';
    if (!await showConfirm('确认删除文件夹？', `确定删除文件夹「${folder.name}」吗？${extra}\n\n此操作仅删除该文件夹及其中的分类引用，不会删除任何图书文件。图书仍保留在「全部图书」中。`, '删除文件夹')) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = state.db.transaction(['folders', 'folderBooks'], 'readwrite'), folders = tx.objectStore('folders'), links = tx.objectStore('folderBooks');
        for (const id of ids) { folders.delete(id); const cursor = links.index('byFolder').openCursor(IDBKeyRange.only(id)); cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } }; }
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('删除文件夹失败'));
      });
      const next = deleteFolderTree(state.folders, state.folderBooks, folderId); state.folders = next.folders; state.folderBooks = next.links; state.selectedBooks.clear();
      if (ids.has(folderRouteId())) navigate('all'); else render(); toast('文件夹及其分类引用已删除，图书保留在全部图书中。');
    } catch (error) { toast(`删除文件夹失败：${error.message || error}`, 'error'); }
  }
  async function removeBooksFromFolder(folderId, bookIds) {
    const folder = folderById(folderId); if (!folder || !bookIds.length) return;
    const titles = bookIds.map(id => visibleBookById(id)?.title).filter(Boolean), label = titles.length === 1 ? `《${titles[0]}》` : `${titles.length} 本选中图书`;
    if (!await showConfirm('确认移除图书？', `确定将${label}从「${folder.name}」中移除吗？\n\n该操作不会删除原始图书，也不会影响「全部图书」或其他文件夹中的图书。`, '确认移除', false)) return;
    try { await saveFolderLinks(removeFolderLinks(state.folderBooks, [folderId], bookIds)); state.selectedBooks.clear(); toast('已从当前文件夹移除，图书仍保留在书库中。'); }
    catch (error) { toast(`移除图书失败：${error.message || error}`, 'error'); }
  }
  async function saveBook(book) { await put('books', book); const i = state.books.findIndex(b => b.id === book.id); if (i >= 0) state.books[i] = book; render(); }
  function showContextMenu(event, html) {
    event.preventDefault(); event.stopPropagation(); const menu = $('libraryContextMenu'); menu.innerHTML = html; menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - rect.width - 8))}px`; menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - rect.height - 8))}px`;
  }
  function showFolderTargetMenu(event, bookIds) {
    const flatten = (parentId, depth = 0) => sortedFolders(parentId).flatMap(folder => [`<button role="menuitem" data-add-to-folder="${esc(folder.id)}"><i class="context-folder-mark" style="--folder-color:${esc(folder.color || '#61a77d')}"></i>${'　'.repeat(depth)}${esc(folder.icon || '📚')}　${esc(folder.name)} <span>${bookIds.every(id => state.folderBooks.some(link => link.folderId === folder.id && link.bookId === id)) ? '✓' : ''}</span></button>`, ...flatten(folder.id, depth + 1)]);
    const actions = flatten(null).join('');
    showContextMenu(event, `${actions || '<p class="context-empty">还没有文件夹</p>'}<button role="menuitem" data-create-and-add="1">＋ 新建文件夹并添加</button>`); $('libraryContextMenu').dataset.bookIds = JSON.stringify(bookIds);
  }
  function showBookMenu(event, bookId) {
    if (!visibleBookById(bookId)) return;
    state.contextBookId = bookId; delete $('libraryContextMenu').dataset.bookIds;
    showContextMenu(event, `<button role="menuitem" data-context-read="1">开始阅读</button><button role="menuitem" data-context-add="1">添加到文件夹</button><button role="menuitem" data-context-create="1">创建文件夹并添加</button><button role="menuitem" data-context-edit="1">编辑图书信息</button>${folderRouteId() ? '<button role="menuitem" data-context-remove="1">从当前文件夹移除</button>' : ''}<button role="menuitem" class="danger-menu-item" data-context-delete="1">删除图书…</button>`);
  }
  function showFolderMenu(event, folderId) {
    state.contextFolderId = folderId; delete $('libraryContextMenu').dataset.bookIds;
    showContextMenu(event, `<button role="menuitem" data-folder-new-child="1">＋ 新建子文件夹</button><button role="menuitem" data-folder-edit="1">重命名 / 编辑</button><button role="menuitem" data-folder-move="-1">上移</button><button role="menuitem" data-folder-move="1">下移</button><button role="menuitem" class="danger-menu-item" data-folder-delete="1">删除文件夹…</button>`);
  }
  async function moveFolder(folderId, direction) {
    const folder = folderById(folderId); if (!folder) return; const siblings = sortedFolders(folder.parentId || null), index = siblings.findIndex(item => item.id === folderId), target = siblings[index + direction]; if (!target) return;
    const a = { ...folder, sortOrder: target.sortOrder ?? index + direction }, b = { ...target, sortOrder: folder.sortOrder ?? index };
    try { const tx = state.db.transaction('folders', 'readwrite'); tx.objectStore('folders').put(a); tx.objectStore('folders').put(b); await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onerror=tx.onabort=()=>reject(tx.error); }); state.folders = state.folders.map(item => item.id === a.id ? a : item.id === b.id ? b : item); renderFolders(); }
    catch (error) { toast(`调整排序失败：${error.message || error}`, 'error'); }
  }
  function pathEqual(left, right) { return String(left || '').replace(/\\/g, '/').toLowerCase() === String(right || '').replace(/\\/g, '/').toLowerCase(); }
  function deleteBookTransaction(bookId) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(['books', 'folderBooks', 'readingStates'], 'readwrite'), books = tx.objectStore('books'), links = tx.objectStore('folderBooks');
      books.delete(bookId); const cursor = links.index('byBook').openCursor(IDBKeyRange.only(bookId)); cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
      tx.objectStore('readingStates').delete(bookId);
      tx.oncomplete = () => { const next = deleteBookEntity(state.books, state.folderBooks, bookId); state.books = next.books; state.folderBooks = next.links; state.readingStates.delete(bookId); state.selectedBooks.delete(bookId); render(); resolve(); };
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('书目与文件夹关系事务失败'));
    });
  }
  async function openBookDeleteDialog(bookId) {
    const book = visibleBookById(bookId); if (!book) return;
    $('bookDeleteText').textContent = `确定从「全部图书」中删除《${book.title}》吗？该操作还会移除所有自定义文件夹中的该书引用。`;
    const managed = book.storageMode === 'managed' && !!book.nativePath, indexed = book.storageMode === 'indexeddb' && !!book.file;
    $('deleteActualOption').classList.toggle('hidden', !managed && !indexed);
    $('deleteActualDescription').textContent = managed ? '文件将先安全暂存，再移入系统回收站。' : '书籍副本保存在本机数据库中，将随书目记录一起删除。';
    $('deleteFilePath').textContent = managed ? `实际文件路径：${book.nativePath}` : indexed ? '实际文件：浏览器本地数据库中的软件副本' : '实际文件不会被删除（外部引用模式）';
    $('deleteFileWarning').textContent = managed ? '删除会清除该书所有文件夹引用。回收站操作仅针对上面显示的这一个软件管理文件。' : '删除会清除该书所有文件夹引用、阅读进度、书签和笔记。';
    document.querySelector('input[name="deleteBookFileMode"][value="keep"]').checked = true;
    $('bookDeleteModal').classList.remove('hidden');
    const confirmed = await new Promise(resolve => {
      const finish = value => { $('bookDeleteModal').classList.add('hidden'); $('bookDeleteAccept').onclick = null; $('bookDeleteCancel').onclick = $('bookDeleteClose').onclick = null; $('bookDeleteModal').onclick = null; resolve(value); };
      $('bookDeleteAccept').onclick = () => finish(true); $('bookDeleteCancel').onclick = $('bookDeleteClose').onclick = () => finish(false); $('bookDeleteModal').onclick = event => { if (event.target === $('bookDeleteModal')) finish(false); };
    });
    if (!confirmed) return;
    const deleteFile = document.querySelector('input[name="deleteBookFileMode"]:checked')?.value === 'delete';
    if (deleteFile && !managed && !indexed) { toast('当前版本不能安全删除外部引用文件，书目记录未删除。', 'error'); return; }
    let staged = null;
    try {
      if (deleteFile && managed) {
        if (state.books.some(item => item.id !== book.id && pathEqual(item.nativePath, book.nativePath))) throw new Error('该文件路径仍被其他书目引用，已阻止删除。');
        if (!window.libraDesktop?.stageLibraryBook || !window.libraDesktop?.trashStagedBook) throw new Error('当前环境不支持安全回收文件；书目未删除。');
        staged = await window.libraDesktop.stageLibraryBook(book.nativePath, book.hash, book.ext); if (!staged?.stagedPath) throw new Error('无法安全暂存图书文件');
      }
      await deleteBookTransaction(book.id);
      if (staged) {
        try { await window.libraDesktop.trashStagedBook(staged.stagedPath); toast('图书记录已删除，实际文件已移入系统回收站。'); }
        catch (error) { await window.libraDesktop.restoreLibraryBook(staged.stagedPath, book.nativePath).catch(() => {}); toast(`图书记录已删除，但文件未能移入回收站，已尝试恢复到原路径：${book.nativePath}。${error.message || error}`, 'error'); }
      } else toast(deleteFile ? '图书及其软件内副本已删除。' : '图书已从全部图书移除，实际文件已保留。');
    } catch (error) {
      if (staged?.stagedPath) await window.libraDesktop.restoreLibraryBook(staged.stagedPath, book.nativePath).catch(() => {});
      toast(`删除图书失败：${error.message || error}`, 'error');
    }
  }
  async function removeBook(id) { await openBookDeleteDialog(id); }
  async function setAuto(enabled) { await put('settings', { key: 'autoImport', value: enabled }); $('autoToggle').classList.toggle('on', enabled); $('watchSwitch').classList.toggle('on', enabled); $('settingsAutoSwitch').classList.toggle('on', enabled); $('autoToggle').innerHTML = `<span></span> 自动入库${enabled ? '已开启' : '已暂停'}`; }
  async function chooseFolder() {
    if (window.libraDesktop?.isDesktop) {
      try { const folder = await window.libraDesktop.chooseDownloadFolder(); if (folder) { $('watchFolderText').textContent = folder; toast('下载保存目录和监控目录已更新。'); } }
      catch (e) { toast(e.message || '选择文件夹失败', 'error'); }
      return;
    }
    if (!window.showDirectoryPicker) { toast('当前浏览器不支持网页文件夹监控。可先手动导入；后续桌面版可使用系统文件监控。', 'error'); return; }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      if (handle.queryPermission && await handle.queryPermission({ mode: 'read' }) !== 'granted') {
        const permission = await handle.requestPermission({ mode: 'read' }); if (permission !== 'granted') throw new Error('没有获得文件夹读取权限');
      }
      state.folder = handle; await put('settings', { key: 'folderHandle', value: handle });
      $('watchFolderText').textContent = handle.name; toast(`开始监控文件夹：${handle.name}`); beginScan();
    } catch (e) { if (e.name !== 'AbortError') toast(e.message || '选择文件夹失败', 'error'); }
  }
  async function scanFolder() {
    if (!state.folder || !state.scanning) return;
    try {
      if (await state.folder.queryPermission({ mode: 'read' }) !== 'granted') { $('watchFolderText').textContent = `${state.folder.name}（需重新授权）`; return; }
      const entries = [];
      for await (const [name, handle] of state.folder.entries()) if (handle.kind === 'file' && ACCEPTED.has(extension(name)) && !name.endsWith('.crdownload') && !name.endsWith('.part')) entries.push([name, handle]);
      const seen = new Set();
      for (const [name, handle] of entries) {
        const file = await handle.getFile(), sig = fileId(file); seen.add(sig);
        const record = await dbRequest('settings', 'readonly', s => s.get(`stable-${sig}`));
        const stable = record?.value?.size === file.size && record?.value?.modified === file.lastModified;
        await put('settings', { key: `stable-${sig}`, value: { size: file.size, modified: file.lastModified, count: stable ? (record.value.count || 1) + 1 : 1 } });
        const current = await dbRequest('tasks', 'readonly', s => s.get(`watch-${sig}`));
        if (!current && record?.value?.count >= 1) {
          await addTask({ id: `watch-${sig}`, name, ext: extension(name), status: 'waiting', progress: 100, message: '检测到完成文件，等待导入', createdAt: Date.now(), imported: false }); render();
          const auto = await dbRequest('settings', 'readonly', s => s.get('autoImport'));
          if (auto?.value !== false) {
            try { await addFile(file, '文件夹监控'); await addTask({ id: `watch-${sig}`, name, ext: extension(name), status: 'done', progress: 100, message: '已自动导入本地图书馆', createdAt: Date.now(), imported: true }); }
            catch (e) { await addTask({ id: `watch-${sig}`, name, ext: extension(name), status: 'error', progress: 0, message: e.message, createdAt: Date.now(), imported: false }); }
          }
          render();
        }
      }
    } catch (e) { console.warn('Folder scan:', e); }
  }
  function beginScan() { if (state.scanTimer) clearInterval(state.scanTimer); state.scanning = true; scanFolder(); state.scanTimer = setInterval(scanFolder, 3500); }
  function initEvents() {
    installReaderControls();
    installAnalyticsSection();
    state.analyticsLastTick = Date.now(); state.analyticsTimer = setInterval(trackActiveReading, 15_000);
    $('readerModal').addEventListener('pointerdown', markReaderActivity, true);
    $('readerModal').addEventListener('keydown', markReaderActivity, true);
    document.querySelectorAll('.nav-item[data-view]').forEach(item => { if (!item.title) item.title = item.textContent.trim(); });
    document.body.addEventListener('click', async e => {
      const route = e.target.closest('[data-view]'); if (route) navigate(route.dataset.view);
      const folderNav = e.target.closest('[data-folder-nav]'); if (folderNav) navigate(`folder:${folderNav.dataset.folderNav}`);
      const expand = e.target.closest('[data-folder-expand]'); if (expand) { const id = expand.dataset.folderExpand; if (state.collapsedFolders.has(id)) state.collapsedFolders.delete(id); else state.collapsedFolders.add(id); renderFolders(); }
      const folderMenuButton = e.target.closest('[data-folder-menu]'); if (folderMenuButton) showFolderMenu(e, folderMenuButton.dataset.folderMenu);
      const bookMenuButton = e.target.closest('[data-book-menu]'); if (bookMenuButton) showBookMenu(e, bookMenuButton.dataset.bookMenu);
      const selection = e.target.closest('[data-book-select]'); if (selection) { if (selection.checked) state.selectedBooks.add(selection.dataset.bookSelect); else state.selectedBooks.delete(selection.dataset.bookSelect); updateSelectionToolbar(); }
      const open = e.target.closest('[data-open]'); if (open) openBook(open.dataset.open).catch(error => { console.error('打开书籍失败', error); toast('无法打开书籍：' + (error?.message || error), 'error'); });
      const fav = e.target.closest('[data-fav]'); if (fav) { const b = state.books.find(x => x.id === fav.dataset.fav); if (b) { b.favorite = !b.favorite; await saveBook(b); } else toast('示例书籍仅展示书架布局。'); }
      const remove = e.target.closest('[data-remove]'); if (remove) removeBook(remove.dataset.remove);
    });
    $('folderCreateNavBtn').onclick = () => openFolderEditor();
    $('folderEditorSave').onclick = saveFolderEditor;
    $('folderEditorClose').onclick = $('folderEditorCancel').onclick = () => $('folderEditorModal').classList.add('hidden');
    $('folderEditorModal').onclick = event => { if (event.target === $('folderEditorModal')) $('folderEditorModal').classList.add('hidden'); };
    $('folderNameInput').onkeydown = event => { if (event.key === 'Enter') saveFolderEditor(); };
    $('bulkAddFolderBtn').onclick = event => showFolderTargetMenu(event, [...state.selectedBooks]);
    $('bulkCreateFolderBtn').onclick = () => openFolderEditor('', null, [...state.selectedBooks]);
    $('bulkRemoveFolderBtn').onclick = () => removeBooksFromFolder(folderRouteId(), [...state.selectedBooks]);
    $('clearBookSelectionBtn').onclick = () => { state.selectedBooks.clear(); renderBooks(); };
    $('libraryContextMenu').addEventListener('click', async event => {
      const menu = $('libraryContextMenu'), button = event.target.closest('button'); if (!button) return;
      const bookId = state.contextBookId, folderId = state.contextFolderId;
      if (button.dataset.addToFolder) { const ids = JSON.parse(menu.dataset.bookIds || JSON.stringify(bookId ? [bookId] : [])); try { await saveFolderLinks(addFolderLinks(state.folderBooks, [button.dataset.addToFolder], ids)); toast(`已添加到「${folderById(button.dataset.addToFolder)?.name || '文件夹'}」。`); } catch (error) { toast(`添加失败：${error.message || error}`, 'error'); } }
      else if (button.dataset.createAndAdd || button.dataset.contextCreate) { const ids = JSON.parse(menu.dataset.bookIds || JSON.stringify(bookId ? [bookId] : [...state.selectedBooks])); menu.classList.add('hidden'); openFolderEditor('', null, ids); return; }
      else if (button.dataset.contextRead) openBook(bookId);
      else if (button.dataset.contextAdd) { showFolderTargetMenu(event, [bookId]); return; }
      else if (button.dataset.contextEdit) { const book = visibleBookById(bookId); if (book) { const title = prompt('图书名称', book.title); if (title === null) { menu.classList.add('hidden'); return; } const author = prompt('作者', book.author || ''); if (author === null) { menu.classList.add('hidden'); return; } book.title = title.trim() || book.title; book.author = author.trim(); await saveBook(book); toast('图书信息已更新。'); } }
      else if (button.dataset.contextRemove) { await removeBooksFromFolder(folderRouteId(), [bookId]); }
      else if (button.dataset.contextDelete) { await openBookDeleteDialog(bookId); }
      else if (button.dataset.folderNewChild) { menu.classList.add('hidden'); openFolderEditor('', folderId); return; }
      else if (button.dataset.folderEdit) { menu.classList.add('hidden'); openFolderEditor(folderId); return; }
      else if (button.dataset.folderMove) await moveFolder(folderId, Number(button.dataset.folderMove));
      else if (button.dataset.folderDelete) await deleteFolder(folderId);
      menu.classList.add('hidden');
    });
    document.addEventListener('click', event => { if (!$('libraryContextMenu').contains(event.target)) $('libraryContextMenu').classList.add('hidden'); });
    $('bookGrid').addEventListener('contextmenu', event => { const card = event.target.closest('[data-book-card]'); if (card) showBookMenu(event, card.dataset.bookCard); });
    $('folderNavTree').addEventListener('contextmenu', event => { const row = event.target.closest('[data-folder-node]'); if (row) showFolderMenu(event, row.dataset.folderNode); });
    $('bookGrid').addEventListener('dragstart', event => { const card = event.target.closest('[data-book-card]'); if (!card) return; const ids = state.selectedBooks.has(card.dataset.bookCard) ? [...state.selectedBooks] : [card.dataset.bookCard]; event.dataTransfer.setData('application/x-libra-book-ids', JSON.stringify(ids)); event.dataTransfer.effectAllowed = 'copy'; });
    $('folderNavTree').addEventListener('dragover', event => { if (event.target.closest('[data-folder-nav]')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; event.target.closest('.folder-nav-row')?.classList.add('drop-target'); } });
    $('folderNavTree').addEventListener('dragleave', event => event.target.closest('.folder-nav-row')?.classList.remove('drop-target'));
    $('folderNavTree').addEventListener('drop', async event => { const target = event.target.closest('[data-folder-nav]'); if (!target) return; event.preventDefault(); const row = target.closest('.folder-nav-row'); row?.classList.remove('drop-target'); try { const ids = JSON.parse(event.dataTransfer.getData('application/x-libra-book-ids') || '[]'); if (ids.length) { await saveFolderLinks(addFolderLinks(state.folderBooks, [target.dataset.folderNav], ids)); state.selectedBooks.clear(); toast(`已整理 ${ids.length} 本图书到「${folderById(target.dataset.folderNav)?.name || ''}」。`); } } catch (error) { toast(`拖放整理失败：${error.message || error}`, 'error'); } });
    $('importBtn').onclick = $('emptyImportBtn').onclick = $('dropImportBtn').onclick = importFromPicker;
    $('dashboardImportBtn').onclick = importFromPicker;
    $('libraryImportFolderBtn').onclick = () => $('dashboardImportFolderBtn').click();
    $('dashboardImportFolderBtn').onclick = () => {
      $('folderImportModal').classList.remove('hidden'); $('folderImportPath').textContent = state.folderImportPath || '尚未选择文件夹';
      $('allowDuplicateImport').checked = false;
      $('folderSelectAll').checked = true;
      $('folderFileList').innerHTML = '<div class="folder-file-empty">选择文件夹后扫描匹配文件。</div>';
      $('folderScanSummary').textContent = '选择文件夹和格式后开始扫描。'; $('folderImportStart').disabled = true;
    };
    $('folderChooseSourceBtn').onclick = async () => {
      try {
        if (androidFilePicker()) {
          const folder = await chooseAndroidFolder();
          if (folder?.cancelled) return;
          nativeAndroidFolder = true;
          folderBrowserFiles = [];
          state.folderImportPath = folder.name || '已选文件夹';
          $('folderImportPath').textContent = state.folderImportPath;
          await scanImportFolder();
          return;
        }
        if (!window.libraDesktop?.isDesktop) {
          if (window.Capacitor?.isNativePlatform?.()) throw new Error('当前安装包不支持原生文件夹授权，请安装新版 APK。');
          $('folderInput').click();
          return;
        }
        const folder = await window.libraDesktop.chooseImportFolder(); if (!folder) return;
        nativeAndroidFolder = false;
        state.folderImportPath = folder; $('folderImportPath').textContent = folder; await scanImportFolder();
      } catch (error) { toast(`选择文件夹失败：${error.message || error}`, 'error'); }
    };
    $('folderInput').onchange = async e => {
      nativeAndroidFolder = false;
      folderBrowserFiles = Array.from(e.target.files || []);
      state.folderImportPath = folderBrowserFiles[0]?.webkitRelativePath?.split('/')[0] || '';
      $('folderImportPath').textContent = state.folderImportPath || '尚未选择文件夹';
      if (folderBrowserFiles.length) await scanImportFolder();
      e.target.value = '';
    };
    $('folderSelectAll').onchange = e => { state.folderImportItems.forEach(item => { item.selected = e.target.checked; }); renderFolderImportFiles(); };
    document.querySelectorAll('.folder-format-list input').forEach(input => {
      input.addEventListener('change', () => { if (state.folderImportPath) void scanImportFolder(); });
    });
    $('folderMinSize').onchange = () => { if (state.folderImportPath) void scanImportFolder(); };
    $('folderScanBtn').onclick = scanImportFolder;
    $('folderFileList').onchange = e => { const input = e.target.closest('[data-import-index]'); if (!input) return; const item = state.folderImportItems[Number(input.dataset.importIndex)]; if (item) item.selected = input.checked; renderFolderImportFiles(); };
    $('folderImportStart').onclick = importFolderSelection;
    $('folderImportClose').onclick = $('folderImportCancel').onclick = () => $('folderImportModal').classList.add('hidden');
    $('folderImportModal').onclick = e => { if (e.target === $('folderImportModal')) $('folderImportModal').classList.add('hidden'); };
    if (window.Capacitor?.isNativePlatform?.()) $('dashboardImportFolderBtn').classList.remove('hidden');
    $('chooseLibraryPathBtn').onclick = migrateLibraryFolder;
    $('fileInput').onchange = async e => { await importFiles(e.target.files, '本地导入'); e.target.value = ''; };
    $('searchInput').oninput = e => { state.query = e.target.value.trim(); renderBooks(); };
    $('topSearchBtn').onclick = () => $('searchInput').focus();
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('searchInput').focus(); }
      if ($('readerLightbox').classList.contains('open') && e.key === 'ArrowLeft') showReaderImage(state.activeImageIndex - 1);
      else if ($('readerLightbox').classList.contains('open') && e.key === 'ArrowRight') showReaderImage(state.activeImageIndex + 1);
      else if (e.key === 'F11' && !$('readerModal').classList.contains('hidden')) { e.preventDefault(); toggleReaderFullscreen(); }
      else if (!$('readerModal').classList.contains('hidden') && !e.target.closest('input,textarea,select') && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'ArrowLeft') { e.preventDefault(); navigateReaderBack(); }
      else if (!$('readerModal').classList.contains('hidden') && !e.target.closest('input,textarea,select') && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); navigateReaderForward(); }
      else if (!$('readerModal').classList.contains('hidden') && !e.target.closest('button,input,textarea,select,[contenteditable="true"]') && !e.ctrlKey && !e.altKey && !e.metaKey && !$('readerLightbox').classList.contains('open') && pageDirectionForKey(e.key, e.shiftKey)) { markReaderActivity(); e.preventDefault(); if (state.readerChapters.length) moveReaderPage(pageDirectionForKey(e.key, e.shiftKey)); }
      else if (!$('readerModal').classList.contains('hidden') && !e.target.closest('input,textarea,select') && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'h') { e.preventDefault(); $('readerModal').classList.toggle('reader-ui-hidden'); }
      else if (e.key === 'Escape') {
        if (document.fullscreenElement) return;
        const modal = $('readerModal');
        const panels = ['readerLightbox','readerNotesPanel','readerSearchPanel','readerPositionHistory','readerToc','readerGallery','readerSettings','readerBookmarks','readerThemePicker','readerSeekPreview'];
        const open = panels.map(id => $(id)).find(el => el && (el.classList.contains('open') || (el.id === 'readerSeekPreview' && !el.classList.contains('hidden'))));
        if (open) { e.preventDefault(); if (open.id === 'readerSeekPreview') open.classList.add('hidden'); else open.classList.remove('open'); }
        else if (!modal.classList.contains('hidden')) { e.preventDefault(); void closeReader(); }
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { if (state.readerBook && state.readerChapters.length) persistReaderPosition(true).catch(error => console.warn('切到后台时保存位置失败', error)); else state.positionService?.flushAll(); } });
    window.addEventListener('beforeunload', () => { if (state.readerBook && state.readerChapters.length) persistReaderPosition(true).catch(error => console.warn('退出时保存位置失败', error)); else state.positionService?.flushAll(); });
    document.addEventListener('fullscreenchange', () => { const active = document.fullscreenElement === $('readerModal'); $('readerFullscreenToggle').innerHTML = active ? '⛶ <span>退出全屏</span>' : '⛶ <span>全屏</span>'; });
    document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('selected')); el.classList.add('selected'); state.filter = el.dataset.filter; renderBooks(); });
    $('sortBtn').onclick = () => { state.sortRecent = !state.sortRecent; $('sortBtn').innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10m-7 6h4"/></svg> ${state.sortRecent ? '最近添加' : '书名排序'} <span class="chevron">⌄</span>`; renderBooks(); };
    document.querySelectorAll('.view-toggle').forEach((el, i) => el.onclick = () => { document.querySelectorAll('.view-toggle').forEach(x => x.classList.remove('active')); el.classList.add('active'); state.listMode = i === 1; renderBooks(); });
    $('autoToggle').onclick = async () => { const s = await dbRequest('settings', 'readonly', x => x.get('autoImport')); setAuto(s?.value === false); };
    $('watchSwitch').onclick = $('settingsAutoSwitch').onclick = async () => { const s = await dbRequest('settings', 'readonly', x => x.get('autoImport')); setAuto(s?.value === false); };
    $('chooseFolderBtn').onclick = chooseFolder;
    if (window.libraDesktop?.isDesktop) {
      window.libraDesktop.onBookFile(handleDesktopBookFile);
      window.libraDesktop.onDownload(handleDesktopDownload);
      $('watchFolderText').textContent = '系统下载文件夹';
      window.libraDesktop.getDownloadFolder().then(folder => { if (folder) $('watchFolderText').textContent = folder; }).catch(() => {});
      window.libraDesktop.getLibraryFolder().then(folder => { if (folder) { state.libraryFolder = folder; $('libraryPathText').textContent = folder; } }).catch(() => { $('libraryPathText').textContent = '读取失败'; });
    } else {
      $('libraryPathText').textContent = '当前为浏览器模式，书籍副本保存在浏览器本地数据库。';
      $('chooseLibraryPathBtn').disabled = true;
    }
    $('clearTasksBtn').onclick = async () => { for (const t of state.tasks.filter(x => x.status === 'done')) await dbRequest('tasks', 'readwrite', s => s.delete(t.id)); state.tasks = state.tasks.filter(x => x.status !== 'done'); renderTasks(); };
    $('downloadTable').addEventListener('click', e => { const button = e.target.closest('[data-import-task]'); if (button) importDesktopTask(button.dataset.importTask); });
    $('clearLibraryBtn').onclick = async () => { if (!await showConfirm('清空书架？', '这会移除全部书目、阅读进度、书签、笔记和文件夹关联；文件夹本身和软件管理目录中的实际文件会保留。', '清空书架')) return; try { const tx = state.db.transaction(['books','folderBooks','readingStates'], 'readwrite'); tx.objectStore('books').clear(); tx.objectStore('folderBooks').clear(); tx.objectStore('readingStates').clear(); await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);}); state.books=[];state.folderBooks=[];state.readingStates.clear();state.selectedBooks.clear();render();toast('书架记录已清空，实际图书文件保留。'); } catch(error) { toast(`清空失败：${error.message || error}`, 'error'); } };
    $('settingsBtn').onclick = () => navigate('settings');
    const helpBtn = document.createElement('button');
    helpBtn.id = 'yomiHelpBtn'; helpBtn.className = 'sidebar-settings';
    helpBtn.innerHTML = '<span class="gear">?</span> 使用帮助';
    helpBtn.onclick = () => onboarding.showHelp();
    $('settingsBtn').before(helpBtn);
    const helpRow = document.createElement('div');
    helpRow.className = 'settings-card';
    helpRow.innerHTML = '<div><strong>使用帮助与新手引导</strong><span>操作指南、快捷键、阅读进度说明，随时可以重新体验。</span></div><button class="secondary-button" id="yomiSettingsHelp">查看帮助</button><button class="secondary-button" id="yomiReplayGuide">重看新手引导</button>';
    $('settingsPage').append(helpRow);
    $('yomiSettingsHelp').onclick = () => onboarding.showHelp();
    $('yomiReplayGuide').onclick = () => onboarding.start();
    fontManager.attach($('settingsPage'), { reader: false, chooseFiles: androidFilePicker() ? nativeFontPicker : null });
    $('themeBtn').onclick = () => { const panel = $('appearancePopover'); panel.classList.toggle('hidden'); $('themeBtn').setAttribute('aria-expanded', String(!panel.classList.contains('hidden'))); };
    document.querySelectorAll('[data-palette-choice]').forEach(button => button.onclick = () => { appearance.palette = button.dataset.paletteChoice; appearance.accent = ''; saveAppearance(); });
    document.querySelectorAll('[data-mode-choice]').forEach(button => button.onclick = () => { appearance.mode = button.dataset.modeChoice; saveAppearance(); });
    $('accentColorInput').oninput = e => { appearance.accent = e.target.value; saveAppearance(); };
    $('accentResetBtn').onclick = () => { appearance.accent = ''; saveAppearance(); };
    document.addEventListener('pointerdown', e => { if (!e.target.closest('#appearancePopover,#themeBtn')) { $('appearancePopover').classList.add('hidden'); $('themeBtn').setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('appearancePopover').classList.contains('hidden')) { $('appearancePopover').classList.add('hidden'); $('themeBtn').setAttribute('aria-expanded', 'false'); e.stopPropagation(); } });
    initCoverDensity();
    document.querySelectorAll('.nav-item').forEach(button => { if (!button.title) button.title = button.textContent.trim(); });
    $('sidebarCollapseBtn').onclick = () => { document.body.classList.toggle('sidebar-collapsed'); const collapsed = document.body.classList.contains('sidebar-collapsed'); localStorage.setItem('libra-sidebar-collapsed', collapsed ? '1' : '0'); $('sidebarCollapseBtn').title = collapsed ? '展开导航' : '收起导航'; };
    $('profileBtn').onclick = () => toast('当前为离线本地模式，书籍数据保存在此浏览器。');
    $('goSiteBtn').onclick = openOnline; $('siteUrl').onkeydown = e => { if (e.key === 'Enter') openOnline(); }; $('embedSiteBtn').onclick = openEmbedded;
    $('siteReload').onclick = () => { const f = $('siteFrame'); if (!f.classList.contains('hidden')) f.src = f.src; else openOnline(); };
    bindReaderEvents();
    const zone = $('dropZone'); zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragging'); }; zone.ondragleave = () => zone.classList.remove('dragging'); zone.ondrop = e => { e.preventDefault(); zone.classList.remove('dragging'); importFiles(e.dataTransfer.files, '拖放导入'); };
    document.addEventListener('dragover', e => e.preventDefault()); document.addEventListener('drop', e => { if (!e.target.closest('#dropZone')) { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files, '拖放导入'); } });
    window.addEventListener('resize', () => { if (state.readerBook && !$('readerModal').classList.contains('hidden')) reflowReaderPreservingPosition(applyReaderStyle).catch(error => console.warn('窗口缩放后恢复阅读位置失败', error)); });
  }
  function normalizedOnlineUrl() {
    let value = $('siteUrl').value.trim(); if (!value) { toast('请输入你自己的 HTTPS 书库访问地址。'); return; }
    if (!/^https:\/\//i.test(value)) value = `https://${value}`;
    try { const url = new URL(value); if (url.protocol !== 'https:') throw new Error('仅允许 HTTPS 地址');
      $('siteOrigin').textContent = url.host; return url;
    } catch (e) { toast(e.message || '地址格式不正确', 'error'); return null; }
  }
  async function openOnline() {
    const url = normalizedOnlineUrl(); if (!url) return;
    try {
      if (window.libraDesktop?.isDesktop && window.libraDesktop.openOnline) {
        await window.libraDesktop.openOnline(url.href);
        toast('已在 Libra Reader 在线书库窗口中打开。登录和 Cookie 验证由目标网站正常处理。');
      } else {
        const tab = window.open(url.href, '_blank');
        if (!tab) toast('浏览器拦截了新标签页，请允许本地预览打开新标签页。', 'error');
        else { tab.opener = null; toast('已在新标签页打开书库。登录和 Cookie 验证由目标网站正常处理。'); }
      }
    } catch (error) {
      toast(`在线书库窗口打开失败：${error.message || error}`, 'error');
    }
    put('settings', { key: 'siteUrl', value: url.href });
  }
  async function resolveOnlineUrl() {
    const url = normalizedOnlineUrl(); if (!url) return null;
    await put('settings', { key: 'siteUrl', value: url.href }); return url.href;
  }
  async function openEmbedded() {
    const url = await resolveOnlineUrl(); if (!url) return;
    $('browserEmpty').classList.add('hidden'); $('siteFrame').classList.remove('hidden'); $('siteFrame').src = url;
    toast('已尝试内嵌打开；如果出现 Cookie 提示，请改用上方“新标签页打开”。');
  }
  async function init() {
    try {
      state.db = await openLibraryDatabase(DB_NAME);
      const [books, tasks, folders, folderBooks, readingStates] = await Promise.all([all('books'), all('tasks'), all('folders'), all('folderBooks'), all('readingStates')]);
      state.books = books; state.tasks = tasks; state.folders = folders; state.folderBooks = folderBooks;
      state.readingStates = new Map(readingStates.map(item => [item.bookId, item]));
      for (const book of state.books) {
        const reading = state.readingStates.get(book.id) || (book.readingState ? { bookId: book.id, ...book.readingState } : null);
        if (!reading) continue;
        book.readingState = reading;
        book.progress = Math.floor(Number(reading.currentProgress ?? reading.currentAnchor?.progress ?? book.progress) || 0);
        if (reading.currentAnchor) { book.chapterIndex = reading.currentAnchor.chapterIndex; book.lastChapterTitle = reading.currentAnchor.chapterTitle || book.lastChapterTitle; }
        book.lastRead = Number(reading.updatedAt) || book.lastRead;
      }
      state.tasks.sort((a,b) => b.createdAt-a.createdAt);
    }
    catch (e) { toast(`本地数据库初始化失败：${e.message}`, 'error'); }
    if (state.db) state.positionService = new ReadingPositionService({
      debounceMs: 2500,
      onError: (error) => { console.warn('阅读位置自动保存失败', error); toast('阅读位置暂未保存成功，仍可继续阅读。', 'error'); },
      persist: async (bookId, snapshot) => {
        const book = state.books.find(item => item.id === bookId); if (!book) return;
        Object.assign(book, snapshot);
        const readingState = { bookId, ...snapshot.readingState };
        state.readingStates.set(bookId, readingState);
        await put('readingStates', readingState);
      }
    });
    try { const savedAnalytics = await dbRequest('settings', 'readonly', store => store.get('readingAnalytics')); if (savedAnalytics?.value) state.readingAnalytics = { days: savedAnalytics.value.days || {}, books: savedAnalytics.value.books || {} }; }
    catch (e) { console.warn('读取阅读统计失败', e); }
    if (state.db) await fontManager.initialize().catch(error => { console.warn('字体库初始化失败', error); toast('自定义字体暂时无法读取。', 'error'); });
    initEvents();
    initAppearance();
    initMobileShell({ navigate, closeReader, readerIsOpen: () => Boolean(state.readerBook),
      canTurnPage: () => state.readerChapters.length > 0, movePage: moveReaderPage });
    const sidebarPreference = localStorage.getItem('libra-sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', sidebarPreference !== '0');
    $('sidebarCollapseBtn').title = sidebarPreference === '0' ? '收起导航' : '展开导航';
    const auto = await dbRequest('settings', 'readonly', s => s.get('autoImport')); await setAuto(auto?.value !== false);
    const savedUrl = await dbRequest('settings', 'readonly', s => s.get('siteUrl')); if (savedUrl?.value) $('siteUrl').value = savedUrl.value;
    const folder = await dbRequest('settings', 'readonly', s => s.get('folderHandle'));
    if (folder?.value) { state.folder = folder.value; try { if (await state.folder.queryPermission({ mode: 'read' }) === 'granted') { $('watchFolderText').textContent = state.folder.name; beginScan(); } else $('watchFolderText').textContent = `${state.folder.name}（点击重新授权）`; } catch (_) {} }
    $('dockOpen').style.display = state.tasks.length ? 'inline-block' : '';
    navigate('home'); render();
    onboarding.maybeAutoStart({ booksCount: state.books.length, tasksCount: state.tasks.length });
  }
  init();
})();
