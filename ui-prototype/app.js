import { createDatabaseQueries, openLibraryDatabase } from './storage/database.js';
import { initMobileShell, isAndroidApp } from './platform/mobile-shell.js';
import { renderMobilePdf } from './platform/pdf-viewer.js';
import { createLibraryView } from './library/library-view.js';
import { createDashboardView } from './home/dashboard-view.js';
import { createReadingAnalytics } from './analytics/reading-analytics.js';
import { createTaskView } from './downloads/task-view.js';
import { parseReaderDocument, readBookMetadata, validateBookFile } from './reader/index.js';
import { createOnboarding } from './onboarding/onboarding.js';
import { addFolderLinks, deleteBookEntity, deleteFolderTree, removeFolderLinks } from './library-model.js';
import { advanceReadingState, NavigationHistoryService, ReadingPositionService } from './reader/position-services.js';

(() => {
  'use strict';
  const DB_NAME = 'libra-reader-preview';
  const ACCEPTED = new Set(['epub', 'pdf', 'txt']);
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
    if (state.books.some(book => book.hash === hash)) { if (!options.quiet) toast(`《${filenameTitle(file.name)}》已在书架中，跳过重复文件。`); return null; }
    const now = Date.now(), id = `${hash.slice(0, 18)}-${now}`;
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
    $('folderImportStart').disabled = selected === 0;
    $('folderImportStart').textContent = `导入选中文件（${selected}）`;
  }
  async function scanImportFolder() {
    if (!state.folderImportPath || !window.libraDesktop?.isDesktop) { toast('请先选择要扫描的文件夹。'); return; }
    const formats = [...document.querySelectorAll('.folder-format-list input:checked')].map(input => input.value);
    if (!formats.length) { toast('至少选择一种文件格式。'); return; }
    const button = $('folderScanBtn'); button.disabled = true; button.textContent = '正在扫描…';
    try {
      const minBytes = Math.max(0, Number($('folderMinSize').value) || 0) * 1024;
      state.folderImportItems = (await window.libraDesktop.scanImportFolder(state.folderImportPath, formats, minBytes)).map(item => ({ ...item, selected: true }));
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
        const result = await window.libraDesktop.readImportFile(item.path);
        if (!result?.bytes) throw new Error('无法读取文件，可能已被移动或删除');
        const file = new File([result.bytes], result.name, { lastModified: result.lastModified });
        const book = await addFile(file, '文件夹导入', item.path, { quiet: true, favorite: $('folderImportFavorite').checked });
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
  function currentReaderStyle() { return state.readerBook?.readerStyle || { fontSize: 17, lineHeight: 1.95, width: 1400, sideMargin: 32, indent: true, theme: 'paper', turnMode: 'page' }; }
  function applyReaderStyle() {
    const style = { sideMargin: 32, ...currentReaderStyle() }, stage = $('readerStage');
    stage.style.fontSize = `${style.fontSize}px`; stage.style.lineHeight = String(style.lineHeight); stage.style.width = `min(${style.width}px, 100%)`;
    stage.style.paddingLeft = `${style.sideMargin}px`; stage.style.paddingRight = `${style.sideMargin}px`;
    stage.classList.toggle('no-indent', !style.indent); $('readerModal').dataset.readerTheme = style.theme || 'paper';
    $('readerFontRange').value = style.fontSize; $('readerFontValue').textContent = `${style.fontSize} px`;
    $('readerLineRange').value = Math.round(style.lineHeight * 10); $('readerLineValue').textContent = Number(style.lineHeight).toFixed(2);
    $('readerWidthRange').max = String(Math.max(1600, Math.ceil((window.innerWidth - 24) / 20) * 20));
    $('readerWidthRange').value = style.width; $('readerWidthValue').textContent = `${style.width} px`;
    $('readerMarginRange').value = style.sideMargin; $('readerMarginValue').textContent = `${style.sideMargin} px`;
    $('readerIndentToggle').checked = !!style.indent; $('readerThemeSelect').value = style.theme || 'paper'; $('readerTurnMode').value = style.turnMode || 'page';
    document.querySelectorAll('[data-reader-theme-option]').forEach(button => {
      const selected = button.dataset.readerThemeOption === (style.theme || 'paper');
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
  }
  async function reflowReaderPreservingPosition(update) {
    const anchor = state.readerChapters.length ? captureReaderAnchor() : null;
    update();
    if (!anchor) return;
    const token = state.styleRestoreToken = (state.styleRestoreToken || 0) + 1;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (token !== state.styleRestoreToken) return;
    await restoreReaderAnchor(anchor);
    await persistReaderPosition(false);
  }
  async function updateReaderStyle(key, value) {
    const book = state.readerBook; if (!book) return;
    book.readerStyle = { ...currentReaderStyle(), [key]: value };
    await reflowReaderPreservingPosition(applyReaderStyle);
    await put('books', book);
  }
  function renderReaderBookmarks() {
    const bookmarks = state.readerBook?.bookmarks || [];
    $('readerBookmarkItems').innerHTML = bookmarks.map((mark, index) => `<div class="bookmark-row"><button class="bookmark-jump" data-bookmark-index="${index}"><b>${esc(mark.chapterTitle)}</b><span>${new Date(mark.createdAt).toLocaleString()} · ${Math.round(mark.scroll || 0)} px</span></button><button class="bookmark-delete" data-bookmark-delete="${index}" aria-label="删除书签">×</button></div>`).join('') || '<p class="gallery-empty">还没有书签。阅读时点击顶部 ☆ 可保存当前位置。</p>';
  }
  function installReaderControls() {
    $('readerModal').querySelector('.reader-top').insertAdjacentHTML('beforeend', '<button class="reader-tool reader-fullscreen" id="readerFullscreenToggle" title="切换全屏">⛶ <span>全屏</span></button>');
    $('readerSettings').querySelector('.reader-toc-head').insertAdjacentHTML('afterend', '<label>滚动方式<select id="readerTurnMode"><option value="page">滚动翻页（带动画）</option><option value="continuous">连续滚动</option></select></label>');
    const widthLabel = $('readerWidthRange').closest('label');
    widthLabel.childNodes[0].textContent = '正文最大宽度 ';
    widthLabel.insertAdjacentHTML('afterend', '<label>正文左右留白 <span id="readerMarginValue">32 px</span><input type="range" id="readerMarginRange" min="0" max="240" step="4" value="32"></label><div class="reader-width-actions"><small>最大宽度控制正文栏宽度；左右留白控制文字距正文栏边缘的距离。</small><button id="readerWidthFillBtn" class="secondary-button">铺满窗口</button></div>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-notes-panel" id="readerNotesPanel"><div class="reader-toc-head"><strong>本书笔记</strong><button id="readerNotesClose" aria-label="关闭笔记">×</button></div><div class="reader-note-composer"><div id="readerNoteQuote" class="reader-note-quote">选择正文后添加摘录，也可以直接写本章笔记。</div><textarea id="readerNoteInput" rows="3" placeholder="写下你的想法…"></textarea><button id="readerNoteSave" class="primary-button">保存笔记</button></div><div id="readerNotesList"></div></aside>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-search-panel" id="readerSearchPanel"><div class="reader-toc-head"><strong>查找正文</strong><button id="readerSearchClose" aria-label="关闭搜索">×</button></div><label class="reader-search-field"><input id="readerSearchInput" type="search" placeholder="输入书中的关键词…"><span id="readerSearchCount">输入至少 2 个字</span></label><div id="readerSearchResults"></div></aside>');
    $('readerModal').insertAdjacentHTML('beforeend', `<footer class="reader-dock" id="readerDock"><div class="reader-theme-picker" id="readerThemePicker" role="group" aria-label="阅读主题"><div class="reader-theme-picker-heading"><strong>选择阅读主题</strong><span>悬停预览 · 点击使用</span></div><div class="reader-theme-options"><button class="reader-theme-option" data-reader-theme-option="paper" data-theme-name="暖纸" style="--theme-bg:#f7f5ee;--theme-ink:#373a35"><i><b></b><b></b><b></b></i><span>暖纸</span></button><button class="reader-theme-option" data-reader-theme-option="ivory" data-theme-name="象牙白" style="--theme-bg:#fffdf7;--theme-ink:#38342c"><i><b></b><b></b><b></b></i><span>象牙白</span></button><button class="reader-theme-option" data-reader-theme-option="sepia" data-theme-name="羊皮纸" style="--theme-bg:#f1e5ce;--theme-ink:#514333"><i><b></b><b></b><b></b></i><span>羊皮纸</span></button><button class="reader-theme-option" data-reader-theme-option="mint" data-theme-name="薄荷绿" style="--theme-bg:#eff6f0;--theme-ink:#2c3931"><i><b></b><b></b><b></b></i><span>薄荷绿</span></button><button class="reader-theme-option" data-reader-theme-option="gray" data-theme-name="雾灰" style="--theme-bg:#edf0f1;--theme-ink:#30363a"><i><b></b><b></b><b></b></i><span>雾灰</span></button><button class="reader-theme-option" data-reader-theme-option="lavender" data-theme-name="淡紫" style="--theme-bg:#f2eff8;--theme-ink:#373342"><i><b></b><b></b><b></b></i><span>淡紫</span></button><button class="reader-theme-option" data-reader-theme-option="night" data-theme-name="夜间" style="--theme-bg:#17191b;--theme-ink:#dedbd3"><i><b></b><b></b><b></b></i><span>夜间</span></button><button class="reader-theme-option" data-reader-theme-option="forest" data-theme-name="深林" style="--theme-bg:#1d2924;--theme-ink:#d8e5dc"><i><b></b><b></b><b></b></i><span>深林</span></button></div></div><div class="reader-dock-actions"><button id="readerDockToc">▤ <span>目录</span></button><button id="readerDockNote">▧ <span>笔记</span></button><button id="readerDockBookmark">▱ <span>书签</span></button><button id="readerDockTheme" aria-expanded="false" aria-controls="readerThemePicker">☼ <span>主题</span></button><button id="readerDockSettings">Aa <span>设置</span></button><button id="readerDockSpeak">♫ <span>朗读</span></button></div><div class="reader-progress-row"><button id="readerProgressPrev" title="上一页">‹</button><div class="reader-progress-info"><span id="readerProgressLabel">0%</span><span id="readerProgressChapter"></span></div><input type="range" id="readerProgressRange" min="0" max="1000" value="0" aria-label="整本书阅读进度"><button id="readerProgressNext" title="下一页">›</button></div></footer>`);
    $('readerDock').querySelector('.reader-dock-actions').insertAdjacentHTML('beforeend', '<button id="readerDockSearch" title="搜索本书">⌕ <span>查找</span></button><button id="readerPositionBack" title="返回上一个阅读位置">↶ <span>上一个位置</span></button><button id="readerPositionForward" title="前进到下一个阅读位置">↷ <span>前进</span></button><button id="readerPositionHistoryToggle" title="阅读位置历史">◷ <span>位置历史</span></button>');
    $('readerDock').insertAdjacentHTML('beforeend', '<div class="reader-seek-preview hidden" id="readerSeekPreview"><div><span id="readerSeekOrigin"></span><strong id="readerSeekTarget"></strong></div><button class="secondary-button" id="readerSeekCancel">取消预览</button><button class="primary-button" id="readerSeekConfirm">跳转至此处</button></div>');
    $('readerDock').insertAdjacentHTML('beforeend', '<div class="reader-undo-notice hidden" id="readerUndoNotice"><span id="readerUndoMessage"></span><button id="readerUndoAction">撤回</button></div>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-position-history" id="readerPositionHistory"><div class="reader-toc-head"><strong>阅读位置历史</strong><button id="readerPositionHistoryClose" aria-label="关闭位置历史">×</button></div><div id="readerPositionHistoryItems"></div></aside>');
  }
  function renderReaderNotes() {
    const notes = state.readerBook?.notes || [];
    $('readerNotesList').innerHTML = notes.map((note, index) => `<article class="reader-note"><header><b>${esc(note.chapterTitle)}</b><div><button data-note-jump="${index}" title="定位到笔记位置">定位</button><button data-note-delete="${index}" aria-label="删除笔记">×</button></div></header>${note.quote ? `<blockquote>${esc(note.quote)}</blockquote>` : ''}<p>${esc(note.text)}</p><small>${new Date(note.createdAt).toLocaleString()}</small></article>`).join('') || '<p class="gallery-empty">还没有笔记。选择正文后点击“笔记”，可保存摘录和想法。</p>';
  }
  function renderReaderSearch(query) {
    const term = String(query || '').trim(), panel = $('readerSearchResults');
    if (!term || term.length < 2) { state.readerSearchResults = []; $('readerSearchCount').textContent = '输入至少 2 个字'; panel.innerHTML = '<p class="position-history-empty">搜索结果会显示章节、上下文和位置。</p>'; return; }
    const results = [];
    state.readerChapters.forEach((chapter, chapterIndex) => (chapter.blocks || []).forEach((block, blockIndex) => {
      if (results.length >= 100) return;
      if (block.type !== 'paragraph') return;
      const text = String(block.value || ''), matchIndex = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
      if (matchIndex < 0) return;
      const start = Math.max(0, matchIndex - 35), end = Math.min(text.length, matchIndex + term.length + 55);
      results.push({ chapterTitle: chapter.title, snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, anchor: { fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex, chapterTitle: chapter.title, blockIndex, charOffset: matchIndex, sourceOffset: Number.isFinite(block.sourceOffset) ? block.sourceOffset + matchIndex : null, chapterScrollRatio: 0, progress: (chapterIndex + (blockIndex + 1) / Math.max(1, chapter.blocks.length + 1)) / Math.max(1, state.readerChapters.length) * 100 } });
      if (results.length >= 100) return;
    }));
    state.readerSearchResults = results; $('readerSearchCount').textContent = results.length >= 100 ? '显示前 100 条结果' : `找到 ${results.length} 条结果`;
    panel.innerHTML = results.map((result, index) => `<button class="reader-search-result" data-reader-search-result="${index}"><b>${esc(result.chapterTitle)}</b><span>${esc(result.snippet)}</span></button>`).join('') || '<p class="position-history-empty">没有找到匹配内容。</p>';
  }
  async function addReaderNote() {
    if (!state.readerBook) return;
    state.pendingNoteQuote = window.getSelection()?.toString().trim().slice(0, 1000) || '';
    $('readerNoteQuote').textContent = state.pendingNoteQuote || '未选择正文，将保存为本章笔记。'; $('readerNoteInput').value = '';
    $('readerNotesPanel').classList.add('open'); $('readerNoteInput').focus();
  }
  async function saveReaderNote() {
    const text = $('readerNoteInput').value.trim(); if (!text) { toast('请先写下笔记内容。'); return; }
    const book = state.readerBook; book.notes = book.notes || [];
    book.notes.unshift({ quote: state.pendingNoteQuote, text, chapterIndex: state.readerChapterIndex, chapterTitle: state.readerChapters[state.readerChapterIndex]?.title || 'PDF 文档', anchor: captureReaderAnchor(), createdAt: Date.now() });
    state.pendingNoteQuote = ''; await put('books', book); renderReaderNotes(); $('readerNoteInput').value = ''; $('readerNoteQuote').textContent = '已保存。继续选择正文即可添加下一条笔记。';
  }
  function toggleReaderSpeech() {
    if (!('speechSynthesis' in window)) { toast('当前系统没有可用的语音朗读服务。', 'error'); return; }
    if (state.speechActive) { speechSynthesis.cancel(); state.speechActive = false; $('readerDockSpeak').innerHTML = '♫ <span>朗读</span>'; return; }
    const text = [...$('readerStage').querySelectorAll('p')].map(p => p.textContent).join('\n');
    if (!text.trim()) { toast('当前章节没有可朗读的文字。'); return; }
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN';
    utterance.onend = utterance.onerror = () => { state.speechActive = false; $('readerDockSpeak').innerHTML = '♫ <span>朗读</span>'; };
    state.speechActive = true; $('readerDockSpeak').innerHTML = '■ <span>停止朗读</span>'; speechSynthesis.cancel(); speechSynthesis.speak(utterance);
  }
  function animateReaderTurn(direction) {
    const body = $('readerModal').querySelector('.reader-body');
    body.classList.remove('page-turn-next', 'page-turn-prev'); void body.offsetWidth;
    body.classList.add(direction > 0 ? 'page-turn-next' : 'page-turn-prev');
    clearTimeout(state.turnTimer); state.turnTimer = setTimeout(() => body.classList.remove('page-turn-next', 'page-turn-prev'), 360);
  }
  function moveReaderPage(direction) {
    const stage = $('readerStage'), maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
    const step = Math.max(220, stage.clientHeight * .82), target = stage.scrollTop + direction * step;
    if (direction > 0 && stage.scrollTop >= maxScroll - 8 && state.readerChapterIndex < state.readerChapters.length - 1) {
      animateReaderTurn(direction); renderChapter(state.readerChapterIndex + 1); recordPageTurn(); persistReaderPosition(); return;
    }
    if (direction < 0 && stage.scrollTop <= 8 && state.readerChapterIndex > 0) {
      animateReaderTurn(direction); renderChapter(state.readerChapterIndex - 1); recordPageTurn();
      requestAnimationFrame(() => { stage.scrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight); updateReaderProgressUI(); persistReaderPosition(); }); return;
    }
    const next = Math.min(maxScroll, Math.max(0, target)); if (next === stage.scrollTop) return;
    animateReaderTurn(direction); stage.scrollTo({ top: next, behavior: 'smooth' }); recordPageTurn();
  }
  async function toggleReaderFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('readerModal').requestFullscreen({ navigationUI: 'hide' });
    } catch (error) { toast(`无法切换全屏：${error.message}`, 'error'); }
  }
  async function addReaderBookmark() {
    const book = state.readerBook; if (!book || !state.readerChapters.length) return;
    const chapter = state.readerChapters[state.readerChapterIndex], stage = $('readerStage');
    book.bookmarks = book.bookmarks || []; book.bookmarks.unshift({ chapterIndex: state.readerChapterIndex, chapterTitle: chapter.title, scroll: stage.scrollTop, anchor: captureReaderAnchor(), createdAt: Date.now() });
    await put('books', book); renderReaderBookmarks(); $('readerBookmarks').classList.add('open'); toast('已保存当前位置书签。');
  }
  function renderChapter(index, restoreScroll = false) {
    if (!state.readerChapters.length) return;
    const chapter = state.readerChapters[index]; if (!chapter) return;
    state.readerChapterIndex = index;
    if (state.readerBook) state.readerBook.lastChapterTitle = chapter.title;
    $('readerChapterTitle').textContent = chapter.title;
    $('readerChapterLabel').textContent = `${index + 1} / ${state.readerChapters.length}`;
    $('readerStage').innerHTML = (chapter.blocks || []).map((block, blockIndex) => {
      if (block.type === 'image') {
        const imageIndex = state.readerImages.findIndex(image => image.src === block.src);
        return `<figure class="reader-illustration" data-reader-block="${blockIndex}"><img src="${esc(block.src)}" alt="${esc(block.alt)}" data-reader-image="${imageIndex}">${block.alt ? `<figcaption>${esc(block.alt)}</figcaption>` : ''}</figure>`;
      }
      const sourceOffset = Number.isFinite(block.sourceOffset) ? ` data-reader-source-offset="${block.sourceOffset}"` : '';
      return `<p data-reader-block="${blockIndex}"${sourceOffset}>${esc(block.value || '')}</p>`;
    }).join('');
    applyReaderStyle();
    $('readerPrev').disabled = index <= 0; $('readerNext').disabled = index >= state.readerChapters.length - 1;
    $('readerTocItems').innerHTML = state.readerChapters.map((ch, i) => `<button class="toc-item ${i === index ? 'selected' : ''}" style="padding-left:${10 + Math.min(4, ch.depth || 0) * 14}px" data-chapter-index="${i}"><span>${String(i + 1).padStart(2, '0')}</span><b>${esc(ch.title)}</b></button>`).join('');
    $('readerStage').scrollTop = restoreScroll && state.readerBook?.chapterIndex === index ? (state.readerBook.chapterScroll || 0) : 0;
    $('readerToc').classList.remove('open');
    updateReaderProgressUI();
  }
  function releaseReaderAssets() { for (const url of state.readerObjectUrls) URL.revokeObjectURL(url); state.readerObjectUrls = []; state.readerImages = []; }
  function showReaderImage(index) {
    if (!state.readerImages.length) return;
    state.activeImageIndex = (index + state.readerImages.length) % state.readerImages.length;
    const image = state.readerImages[state.activeImageIndex];
    $('readerLightboxImage').src = image.src; $('readerLightboxImage').alt = image.alt || `插图 ${state.activeImageIndex + 1}`;
    $('readerLightboxCaption').textContent = `${image.chapterTitle} · ${state.activeImageIndex + 1} / ${state.readerImages.length}${image.alt ? ` · ${image.alt}` : ''}`;
    $('readerLightbox').classList.remove('original-size'); $('readerImageScaleToggle').textContent = '原始尺寸';
    $('readerLightbox').classList.add('open');
  }
  function renderReaderGallery() {
    $('readerGalleryToggle').disabled = !state.readerImages.length;
    $('readerGalleryItems').innerHTML = state.readerImages.map((image, i) => `<button class="gallery-image" data-gallery-image="${i}" title="${esc(image.alt || `插图 ${i + 1}`)}"><img src="${esc(image.src)}" alt=""><span><b>${esc(image.chapterTitle)}</b><small>插图 ${i + 1}${image.alt ? ` · ${esc(image.alt)}` : ''}</small></span></button>`).join('') || '<p class="gallery-empty">这本书没有可识别的 EPUB 插图。</p>';
  }
  function readerTextOptions() {
    return state.readerBook?.readerTextSettings || { encoding: 'utf-8', pattern: '' };
  }
  async function previewTextChapters() {
    const encoding = $('txtEncodingSelect').value, pattern = $('txtPatternInput').value.trim();
    try {
      const doc = await parseReaderDocument(state.readerBook.file, 'txt', { encoding, pattern: pattern || undefined });
      $('txtPreview').innerHTML = `<strong>识别到 ${doc.chapters.length} 个章节</strong><ol>${doc.chapters.slice(0, 16).map(ch => `<li>${esc(ch.title)}</li>`).join('')}</ol>${doc.chapters.length > 16 ? `<small>另有 ${doc.chapters.length - 16} 章未显示</small>` : ''}`;
      return doc;
    } catch (error) { $('txtPreview').innerHTML = `<p class="txt-preview-error">规则或编码无效：${esc(error.message)}</p>`; return null; }
  }
  async function applyTextChapterSettings() {
    const book = state.readerBook, pattern = $('txtPatternInput').value.trim(), encoding = $('txtEncodingSelect').value;
    const doc = await previewTextChapters(); if (!doc) return;
    state.readerChapters = doc.chapters; state.readerImages = [];
    book.readerTextSettings = { encoding, pattern };
    state.readerChapterIndex = Math.min(state.readerChapterIndex, state.readerChapters.length - 1);
    await put('books', book); renderReaderGallery(); renderChapter(state.readerChapterIndex);
    $('readerSettings').classList.remove('open'); toast(`已应用章节识别：${doc.chapters.length} 章。`);
  }
  function readerBlockWeight(block) { return Math.max(1, String(block?.value || '').length); }
  function readerChapterWeight(chapter) { return Math.max(1, (chapter?.blocks || []).reduce((sum, block) => sum + readerBlockWeight(block), 0)); }
  function readerPositionProgress(chapterIndex, blockIndex, charOffset) {
    const chapters = state.readerChapters; if (!chapters.length) return 0;
    const total = chapters.reduce((sum, chapter) => sum + readerChapterWeight(chapter), 0);
    let preceding = 0;
    for (let index = 0; index < Math.min(chapterIndex, chapters.length); index++) preceding += readerChapterWeight(chapters[index]);
    const chapter = chapters[chapterIndex], blocks = chapter?.blocks || [];
    for (let index = 0; index < Math.min(blockIndex, blocks.length); index++) preceding += readerBlockWeight(blocks[index]);
    const currentBlock = blocks[blockIndex];
    if (currentBlock?.type === 'paragraph') preceding += Math.min(readerBlockWeight(currentBlock), Math.max(0, Number(charOffset) || 0));
    return Math.max(0, Math.min(100, preceding / Math.max(1, total) * 100));
  }
  function currentReaderProgress() { return captureReaderAnchor()?.progress || 0; }
  function captureReaderAnchor() {
    const book = state.readerBook, stage = $('readerStage'), chapter = state.readerChapters[state.readerChapterIndex];
    if (!book || !chapter) return null;
    const stageRect = stage.getBoundingClientRect(), paragraphs = [...stage.querySelectorAll('[data-reader-block]')];
    const paragraph = paragraphs.find(item => item.getBoundingClientRect().bottom > stageRect.top + 2) || paragraphs.at(-1);
    const text = paragraph?.textContent || '', rect = paragraph?.getBoundingClientRect();
    const verticalRatio = rect?.height ? Math.max(0, Math.min(1, (stageRect.top - rect.top) / rect.height)) : 0;
    const charOffset = Math.max(0, Math.min(text.length, Math.round(text.length * verticalRatio)));
    const maxScroll = Math.max(1, stage.scrollHeight - stage.clientHeight);
    const blockIndex = paragraph ? Number(paragraph.dataset.readerBlock) : 0;
    const progress = readerPositionProgress(state.readerChapterIndex, blockIndex, charOffset);
    const sourceOffset = paragraph?.dataset.readerSourceOffset !== undefined
      ? Number(paragraph.dataset.readerSourceOffset) + charOffset : null;
    return {
      fileHash: book.hash || '', chapterId: chapter.id || '', chapterIndex: state.readerChapterIndex,
      chapterTitle: chapter.title || '', blockIndex,
      charOffset, sourceOffset: Number.isFinite(sourceOffset) ? sourceOffset : null,
      chapterScrollRatio: Math.max(0, Math.min(1, stage.scrollTop / maxScroll)), progress,
      context: text.slice(Math.max(0, charOffset - 24), charOffset + 48), capturedAt: Date.now()
    };
  }
  function persistedReaderSnapshot(book, readingState, anchor) {
    return { readingState, chapterIndex: anchor.chapterIndex, chapterScroll: $('readerStage').scrollTop, progress: anchor.progress,
      lastRead: Date.now(), lastChapterTitle: anchor.chapterTitle || book.lastChapterTitle };
  }
  async function persistReaderPosition(immediate = false) {
    const book = state.readerBook; if (!book || !state.readerChapters.length) return;
    const anchor = captureReaderAnchor(); if (!anchor) return;
    const timestamp = Date.now(), previous = book.readingState || {};
    const readingState = advanceReadingState(previous, anchor, timestamp);
    readingState.navigation = state.navigationService.export(book.id);
    readingState.sessions = readingState.navigation.sessions;
    const session = readingState.sessions.find(item => item.id === state.activeReaderSessionId);
    if (session) session.endAnchor = anchor;
    book.readingState = readingState; book.chapterIndex = anchor.chapterIndex; book.chapterScroll = $('readerStage').scrollTop;
    book.progress = Math.floor(anchor.progress); book.lastRead = timestamp; book.lastChapterTitle = anchor.chapterTitle;
    updateReaderProgressUI(); renderReaderPositionHistory();
    const snapshot = persistedReaderSnapshot(book, readingState, anchor);
    state.positionService?.schedule(book.id, snapshot);
    if (immediate) await state.positionService?.flush(book.id);
  }
  function restoreReaderAnchor(anchor, { save = false } = {}) {
    return new Promise(resolve => {
      if (!anchor || !state.readerBook || !state.readerChapters.length) { resolve(false); return; }
      const sameFile = !anchor.fileHash || !state.readerBook.hash || anchor.fileHash === state.readerBook.hash;
      let index = sameFile && anchor.chapterId ? state.readerChapters.findIndex(chapter => chapter.id === anchor.chapterId) : -1;
      if (index < 0) index = Math.max(0, Math.min(state.readerChapters.length - 1, Number(anchor.chapterIndex) || 0));
      state.restoringPosition = true; renderChapter(index, false);
      requestAnimationFrame(() => {
        const stage = $('readerStage'), paragraphs = [...stage.querySelectorAll('[data-reader-block]')];
        let paragraph = null, charOffset = Number(anchor.charOffset) || 0;
        if (sameFile && Number.isFinite(anchor.sourceOffset)) {
          const sourceBlocks = paragraphs.filter(item => Number.isFinite(Number(item.dataset.readerSourceOffset)));
          paragraph = sourceBlocks.filter(item => Number(item.dataset.readerSourceOffset) <= anchor.sourceOffset).at(-1) || sourceBlocks[0];
          if (paragraph) charOffset = Math.max(0, anchor.sourceOffset - Number(paragraph.dataset.readerSourceOffset));
        }
        if (!paragraph && sameFile) paragraph = paragraphs.find(item => Number(item.dataset.readerBlock) === Number(anchor.blockIndex));
        const maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollTop = 0;
        if (paragraph) {
          const textNode = paragraph.firstChild;
          if (textNode?.nodeType === Node.TEXT_NODE && textNode.length) {
            const offset = Math.max(0, Math.min(textNode.length - 1, charOffset)), range = document.createRange();
            range.setStart(textNode, offset); range.setEnd(textNode, Math.min(textNode.length, offset + 1));
            const rangeRect = range.getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
            if (rangeRect.height) stage.scrollTop = Math.max(0, Math.min(maxScroll, stage.scrollTop + rangeRect.top - stageRect.top));
          } else { const targetRect = paragraph.getBoundingClientRect(), stageRect = stage.getBoundingClientRect(); stage.scrollTop = Math.max(0, Math.min(maxScroll, stage.scrollTop + targetRect.top - stageRect.top)); }
        } else stage.scrollTop = Math.max(0, Math.min(maxScroll, (Number(anchor.chapterScrollRatio) || 0) * maxScroll));
        updateReaderProgressUI(); state.restoringPosition = false;
        if (save) persistReaderPosition(true).catch(error => console.warn('恢复位置保存失败', error));
        resolve(true);
      });
    });
  }
  function updateReaderProgressUI() {
    if (!state.readerChapters.length || !$('readerProgressRange')) return;
    const stage = $('readerStage');
    const percent = currentReaderProgress();
    const range = $('readerProgressRange'); range.value = Math.round(percent * 10);
    range.style.setProperty('--progress', `${percent}%`);
    const pageCount = Math.max(1, Math.ceil(stage.scrollHeight / Math.max(1, stage.clientHeight))), pageIndex = Math.min(pageCount, Math.floor(stage.scrollTop / Math.max(1, stage.clientHeight)) + 1);
    $('readerProgressLabel').textContent = `${percent.toFixed(1)}%${currentReaderStyle().turnMode === 'page' ? ` · ${pageIndex}/${pageCount} 页` : ''}`;
    $('readerProgressChapter').textContent = state.readerChapters[state.readerChapterIndex]?.title || '';
    const history = state.navigationService.state(state.readerBook.id);
    $('readerPositionBack').disabled = history.undoStack.length === 0;
    $('readerPositionForward').disabled = history.redoStack.length === 0;
  }
  function readerAnchorLabel(anchor) { return `${anchor?.chapterTitle || '正文'} · ${Number(anchor?.progress || 0).toFixed(1)}%`; }
  function progressTarget(value) {
    const chapters = state.readerChapters, total = chapters.length; if (!total) return null;
    const ratio = Math.max(0, Math.min(1, value / 1000)), weights = chapters.map(readerChapterWeight), documentWeight = weights.reduce((sum, item) => sum + item, 0);
    let remaining = ratio * documentWeight, index = total - 1;
    for (let chapterIndex = 0; chapterIndex < total; chapterIndex++) {
      if (remaining <= weights[chapterIndex] || chapterIndex === total - 1) { index = chapterIndex; break; }
      remaining -= weights[chapterIndex];
    }
    const chapter = chapters[index], blocks = chapter.blocks || []; let local = Math.max(0, Math.min(weights[index], remaining)), blockIndex = 0, charOffset = 0;
    for (let current = 0; current < blocks.length; current++) {
      const weight = readerBlockWeight(blocks[current]);
      if (local <= weight || current === blocks.length - 1) { blockIndex = current; charOffset = blocks[current]?.type === 'paragraph' ? Math.min(weight, local) : 0; break; }
      local -= weight;
    }
    const block = blocks[blockIndex];
    const anchor = { fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex: index, chapterTitle: chapter.title, blockIndex, charOffset, sourceOffset: block?.type === 'paragraph' && Number.isFinite(block.sourceOffset) ? block.sourceOffset + charOffset : null, chapterScrollRatio: remaining / Math.max(1, weights[index]), progress: ratio * 100 };
    return { index, ratio, anchor };
  }
  function renderSeekPreview(value) {
    const target = progressTarget(value); if (!target) return;
    state.pendingSeekValue = value; $('readerSeekPreview').classList.remove('hidden');
    const current = captureReaderAnchor(); $('readerSeekOrigin').textContent = `原位置：${readerAnchorLabel(current)}`;
    $('readerSeekTarget').textContent = `预览目标：${state.readerChapters[target.index]?.title || '正文'} · ${(target.ratio * 100).toFixed(1)}%`;
    $('readerSeekConfirm').disabled = Math.abs((current?.progress || 0) - target.ratio * 100) < .15;
  }
  function queueReaderNavigation(action) {
    const task = (state.navigationTask || Promise.resolve()).catch(() => {}).then(action);
    state.navigationTask = task.catch(error => { console.warn('阅读位置跳转失败', error); toast(`阅读位置跳转失败：${error.message || error}`, 'error'); });
    return state.navigationTask;
  }
  async function navigateReaderToAnchor(targetAnchor, eventType) {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, from = captureReaderAnchor(); if (!book || !from || !targetAnchor) return;
      if (Math.abs((from.progress || 0) - (targetAnchor.progress || 0)) < .1 && from.chapterId === targetAnchor.chapterId && from.blockIndex === targetAnchor.blockIndex) return;
      await persistReaderPosition(true);
      await restoreReaderAnchor(targetAnchor);
      const to = captureReaderAnchor(), entry = state.navigationService.recordJump(book.id, from, to, eventType);
      if (!entry) { await persistReaderPosition(true); return; }
      await persistReaderPosition(true); showReaderUndoNotice(from, to); renderReaderPositionHistory();
    });
  }
  async function confirmProgressSeek() {
    return queueReaderNavigation(async () => {
      const target = progressTarget(state.pendingSeekValue); if (!target || !state.readerBook) return;
      const from = captureReaderAnchor(); await persistReaderPosition(true);
      animateReaderTurn(target.ratio * 100 >= (from?.progress || 0) ? 1 : -1);
      await restoreReaderAnchor(target.anchor);
      state.pendingSeekValue = null; $('readerSeekPreview').classList.add('hidden');
      const to = captureReaderAnchor(), entry = state.navigationService.recordJump(state.readerBook.id, from, to, '进度条');
      await persistReaderPosition(true);
      if (entry) showReaderUndoNotice(from, to);
      renderReaderPositionHistory();
    });
  }
  async function navigateReaderBack() {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, current = captureReaderAnchor(); if (!book || !current) return;
      const target = state.navigationService.back(book.id, current); if (!target) { toast('没有可返回的阅读位置。'); return; }
      await restoreReaderAnchor(target); await persistReaderPosition(true); renderReaderPositionHistory();
    });
  }
  async function navigateReaderForward() {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, current = captureReaderAnchor(); if (!book || !current) return;
      const target = state.navigationService.forward(book.id, current); if (!target) { toast('没有可前进的阅读位置。'); return; }
      await restoreReaderAnchor(target); await persistReaderPosition(true); renderReaderPositionHistory();
    });
  }
  function showReaderUndoNotice(from, to) {
    $('readerUndoMessage').textContent = `已跳转到 ${readerAnchorLabel(to)}`;
    $('readerUndoNotice').classList.remove('hidden'); clearTimeout(state.undoNoticeTimer);
    state.undoNoticeTimer = setTimeout(() => $('readerUndoNotice').classList.add('hidden'), 6500);
    $('readerUndoAction').onclick = () => { $('readerUndoNotice').classList.add('hidden'); navigateReaderBack(); };
  }
  function renderReaderPositionHistory() {
    const panel = $('readerPositionHistoryItems'); if (!panel || !state.readerBook) return;
    if (state.readerBook.ext?.toLowerCase() === 'pdf') {
      panel.innerHTML = '<p class="position-history-empty">PDF 当前使用系统内置预览器，暂不提供精确位置锚点、跳转历史和撤回。</p>';
      $('readerPositionBack').disabled = $('readerPositionForward').disabled = true;
      return;
    }
    const saved = state.navigationService.export(state.readerBook.id), reading = state.readerBook.readingState || {};
    $('readerPositionBack').disabled = saved.undoStack.length === 0;
    $('readerPositionForward').disabled = saved.redoStack.length === 0;
    const entries = [...saved.entries].reverse();
    panel.innerHTML = `<section class="position-current"><strong>当前阅读位置</strong><span>${esc(readerAnchorLabel(reading.currentAnchor || captureReaderAnchor()))}</span><small>历史最远进度 ${Number(reading.furthestProgress || 0).toFixed(1)}%</small></section><h3>最近跳转</h3>${entries.length ? entries.map(entry => `<button class="position-history-item" data-position-entry="${esc(entry.id)}"><i>↶</i><span><b>${esc(entry.targetAnchor?.chapterTitle || '正文')}</b><small>${esc(entry.eventType)} · ${new Date(entry.createdAt).toLocaleString()}</small></span><em>${Number(entry.targetAnchor?.progress || 0).toFixed(1)}%</em></button>`).join('') : '<p class="position-history-empty">目录、书签或进度条跳转后会记录在这里。</p>'}<h3>最近阅读会话</h3>${saved.sessions.length ? [...saved.sessions].reverse().map(session => `<div class="position-session"><span><b>${new Date(session.startedAt).toLocaleString()}</b><small>${session.endedAt ? '已结束' : '本次阅读'} · 起点 ${esc(session.startAnchor?.chapterTitle || '正文')} ${Number(session.startAnchor?.progress || 0).toFixed(1)}%</small></span><button data-session-start="${esc(session.id)}">起点</button>${session.endAnchor ? `<button data-session-end="${esc(session.id)}">终点</button>` : ''}</div>`).join('') : '<p class="position-history-empty">重新打开图书后，会在这里保留最近会话的起点和终点。</p>'}`;
  }
  async function openBook(id) {
    const book = state.books.find(b => b.id === id);
    if (!book) { toast('这是书架样式示例。导入自己的 EPUB、PDF 或 TXT 后即可在此阅读。'); return; }
    if (state.readerBook) await closeReader();
    state.navigationService.load(book.id, book.readingState?.navigation || { sessions: book.readingState?.sessions || [] });
    state.activeReaderSessionId = '';
    if (window.libraDesktop?.isDesktop && book.nativePath) {
      try {
        const stored = await window.libraDesktop.readLibraryBook(book.nativePath);
        if (stored?.bytes) book.file = new File([stored.bytes], book.name, { lastModified: stored.lastModified });
      } catch (e) { console.warn('无法从软件书库读取文件，尝试使用本地缓存', e); }
    }
    if (!book.file) { toast('找不到这本书的本地副本，请在设置中迁移或重新导入。', 'error'); return; }
    releaseReaderAssets(); state.readerBook = book; state.readerChapters = []; markReaderActivity(); $('readerModal').classList.remove('hidden'); $('readerBookName').textContent = book.title;
    $('readerToc').classList.remove('open'); $('readerGallery').classList.remove('open'); $('readerSettings').classList.remove('open'); $('readerBookmarks').classList.remove('open'); $('readerNotesPanel').classList.remove('open'); $('readerSearchPanel').classList.remove('open'); $('readerPositionHistory').classList.remove('open'); $('readerLightbox').classList.remove('open'); $('readerTocItems').innerHTML = ''; $('readerChapterTitle').textContent = '';
    clearTimeout(state.readerSearchTimer); $('readerSearchInput').value = ''; state.readerSearchResults = []; renderReaderSearch('');
    const stage = $('readerStage'); stage.innerHTML = ''; stage.onscroll = null;
    const ext = book.ext.toLowerCase();
    $('txtTools').classList.add('hidden');
    renderReaderNotes();
    if (ext === 'pdf') {
      if (isAndroidApp()) {
        try {
          stage.__yomiPdfCleanup = await renderMobilePdf({ stage, file: book.file });
          const restore = Math.max(0, Math.min(1, Number(book.pdfScrollRatio) || 0));
          requestAnimationFrame(() => { stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * restore; });
          stage.onscroll = () => {
            const ratio = stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight);
            book.pdfScrollRatio = Math.min(1, Math.max(0, ratio));
            book.progress = Math.floor(book.pdfScrollRatio * 100);
            clearTimeout(state.progressTimer);
            state.progressTimer = setTimeout(() => put('books', book).catch(error => console.warn('保存 PDF 阅读进度失败', error)), 1200);
          };
        } catch (error) {
          stage.textContent = '无法打开此 PDF：' + (error.message || error);
          console.warn('Android PDF 预览失败', error);
        }
      } else {
        const frame = document.createElement('iframe'); frame.title = book.title;
        frame.src = URL.createObjectURL(book.file);
        state.readerObjectUrls.push(frame.src);
        stage.append(frame);
      }
      $('readerChapterLabel').textContent = 'PDF 文档'; $('readerChapterTitle').textContent = 'PDF 阅读预览'; $('readerPrev').disabled = $('readerNext').disabled = $('readerBookmarkAdd').disabled = true; $('readerTocToggle').disabled = $('readerGalleryToggle').disabled = true; $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = true;
      $('readerDockSearch').disabled = true;
    } else {
      $('readerDockSearch').disabled = false;
      try {
        const textOptions = readerTextOptions();
        $('txtTools').classList.toggle('hidden', ext !== 'txt');
        $('txtEncodingSelect').value = textOptions.encoding || 'utf-8'; $('txtPatternInput').value = textOptions.pattern || ''; $('txtPreview').innerHTML = '';
        const documentData = await parseReaderDocument(book.file, ext, ext === 'txt' ? textOptions : {});
        state.readerChapters = documentData.chapters; state.readerObjectUrls = documentData.objectUrls || [];
        $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = false;
        state.readerImages = state.readerChapters.flatMap((chapter, chapterIndex) => (chapter.blocks || []).filter(block => block.type === 'image').map(block => ({ ...block, chapterIndex, chapterTitle: chapter.title })));
        if (!state.readerChapters.length) state.readerChapters = [{ title: '正文', blocks: [] }];
        $('readerTocToggle').disabled = false;
        renderReaderGallery(); renderReaderBookmarks(); renderReaderNotes(); applyReaderStyle(); $('readerBookmarkAdd').disabled = false;
        const savedAnchor = book.readingState?.currentAnchor;
        const matchingAnchor = savedAnchor && (!savedAnchor.fileHash || savedAnchor.fileHash === book.hash) ? savedAnchor : null;
        const chapterById = matchingAnchor?.chapterId ? state.readerChapters.findIndex(chapter => chapter.id === matchingAnchor.chapterId) : -1;
        const savedIndex = Math.max(0, Math.min(Number.isInteger(chapterById) && chapterById >= 0 ? chapterById : Number.isInteger(book.chapterIndex) ? book.chapterIndex : (book.progress ? Math.floor(book.progress / 100 * state.readerChapters.length) : 0), state.readerChapters.length - 1));
        renderChapter(savedIndex, true);
        if (matchingAnchor) await restoreReaderAnchor(matchingAnchor);
        if (ext === 'txt' && state.readerChapters.length === 1 && state.readerChapters[0].title === '正文') toast('未识别到常见章节标题，已按全文显示；可在目录中查看识别结果。');
      } catch (e) { releaseReaderAssets(); stage.textContent = `无法解析书籍内容：${e.message}`; $('readerChapterLabel').textContent = '解析失败'; $('readerTocToggle').disabled = $('readerGalleryToggle').disabled = true; $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = true; }
    }
    book.lastRead = Date.now();
      if (state.readerChapters.length) {
      stage.onscroll = () => { markReaderActivity(); updateReaderProgressUI(); if (state.restoringPosition) return; clearTimeout(state.progressTimer); state.progressTimer = setTimeout(() => { persistReaderPosition(false).catch(e => console.warn('保存阅读进度失败', e)); }, 180); };
      const startAnchor = captureReaderAnchor();
      if (startAnchor) { const session = state.navigationService.beginSession(book.id, startAnchor); state.activeReaderSessionId = session.id; await persistReaderPosition(true); }
    } else { await put('books', book); }
    renderReaderPositionHistory();
    onboarding.onReaderReady(ext);
  }
  async function closeReader() {
    const book = state.readerBook; if (!book) { $('readerModal').classList.add('hidden'); return; }
    await state.navigationTask?.catch(() => {});
    if (state.readerBook !== book) return;
    clearTimeout(state.progressTimer);
    $('readerStage').__yomiPdfCleanup?.();
    $('readerStage').__yomiPdfCleanup = null;
    $('readerStage').onscroll = null;
    if (state.readerChapters.length) {
      const anchor = captureReaderAnchor();
      if (state.activeReaderSessionId) state.navigationService.endSession(book.id, state.activeReaderSessionId, anchor);
      await persistReaderPosition(true).catch(error => { console.warn('关闭阅读器时保存位置失败', error); toast('阅读位置暂未保存成功，稍后重新打开时仍会尝试恢复上次保存的位置。', 'error'); });
    } else await state.positionService?.flush(book.id).catch(error => console.warn('关闭时保存队列失败', error));
    if (document.fullscreenElement === $('readerModal')) await document.exitFullscreen().catch(() => {});
    if (state.speechActive) speechSynthesis.cancel(); state.speechActive = false;
    onboarding.onReaderClosed();
    state.activeReaderSessionId = ''; state.readerBook = null; state.readerChapters = [];
    $('readerModal').classList.add('hidden'); $('readerLightbox').classList.remove('open'); $('readerPositionHistory').classList.remove('open'); $('readerSeekPreview').classList.add('hidden');
    releaseReaderAssets(); renderDashboard();
  }
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
  // Reader-specific interactions are isolated from the library/shell bindings.
  function bindReaderEvents() {
    $('readerBack').onclick = closeReader;
    $('readerFullscreenToggle').onclick = toggleReaderFullscreen;
    $('readerTocToggle').onclick = () => $('readerToc').classList.toggle('open'); $('readerTocClose').onclick = () => $('readerToc').classList.remove('open');
    $('readerGalleryToggle').onclick = () => $('readerGallery').classList.toggle('open'); $('readerGalleryClose').onclick = () => $('readerGallery').classList.remove('open');
    $('readerSettingsToggle').onclick = () => $('readerSettings').classList.toggle('open'); $('readerSettingsClose').onclick = () => $('readerSettings').classList.remove('open');
    $('readerBookmarkAdd').onclick = addReaderBookmark; $('readerBookmarksClose').onclick = () => $('readerBookmarks').classList.remove('open');
    $('readerNotesClose').onclick = () => $('readerNotesPanel').classList.remove('open');
    $('readerDockSearch').onclick = () => { $('readerSearchPanel').classList.toggle('open'); if ($('readerSearchPanel').classList.contains('open')) $('readerSearchInput').focus(); };
    $('readerSearchClose').onclick = () => $('readerSearchPanel').classList.remove('open');
    $('readerSearchInput').oninput = () => { clearTimeout(state.readerSearchTimer); state.readerSearchTimer = setTimeout(() => renderReaderSearch($('readerSearchInput').value), 180); };
    $('readerSearchResults').onclick = e => { const button = e.target.closest('[data-reader-search-result]'); if (!button) return; const result = state.readerSearchResults[Number(button.dataset.readerSearchResult)]; if (!result) return; $('readerSearchPanel').classList.remove('open'); navigateReaderToAnchor(result.anchor, '搜索'); };
    $('readerNoteSave').onclick = saveReaderNote;
    $('readerNotesList').onclick = async e => {
      const jump = e.target.closest('[data-note-jump]');
      if (jump) {
        const note = state.readerBook?.notes?.[Number(jump.dataset.noteJump)]; if (!note) return;
        const anchor = note.anchor || { fileHash: state.readerBook.hash, chapterIndex: note.chapterIndex, chapterId: state.readerChapters[note.chapterIndex]?.id, chapterTitle: note.chapterTitle, blockIndex: 0, charOffset: 0, chapterScrollRatio: 0, progress: note.chapterIndex / Math.max(1, state.readerChapters.length) * 100 };
        $('readerNotesPanel').classList.remove('open'); await navigateReaderToAnchor(anchor, '笔记'); return;
      }
      const button = e.target.closest('[data-note-delete]'); if (!button) return;
      state.readerBook.notes.splice(Number(button.dataset.noteDelete), 1); await put('books', state.readerBook); renderReaderNotes();
    };
    $('readerBookmarkItems').onclick = async e => {
      const remove = e.target.closest('[data-bookmark-delete]');
      if (remove) { state.readerBook.bookmarks.splice(Number(remove.dataset.bookmarkDelete), 1); await put('books', state.readerBook); renderReaderBookmarks(); return; }
      const jump = e.target.closest('[data-bookmark-index]');
      if (jump) { const mark = state.readerBook.bookmarks[Number(jump.dataset.bookmarkIndex)]; if (mark) { const anchor = mark.anchor || { fileHash: state.readerBook.hash, chapterIndex: mark.chapterIndex, chapterId: state.readerChapters[mark.chapterIndex]?.id, chapterTitle: mark.chapterTitle, chapterScrollRatio: Math.min(1, (mark.scroll || 0) / Math.max(1, $('readerStage').scrollHeight - $('readerStage').clientHeight)), progress: state.readerBook.progress || 0 }; $('readerBookmarks').classList.remove('open'); navigateReaderToAnchor(anchor, '书签'); } }
    };
    $('readerFontRange').oninput = e => updateReaderStyle('fontSize', Number(e.target.value));
    $('readerLineRange').oninput = e => updateReaderStyle('lineHeight', Number(e.target.value) / 10);
    $('readerWidthRange').oninput = e => updateReaderStyle('width', Number(e.target.value));
    $('readerMarginRange').oninput = e => updateReaderStyle('sideMargin', Number(e.target.value));
    $('readerWidthFillBtn').onclick = async () => {
      const book = state.readerBook; if (!book) return;
      const width = Math.max(520, Math.floor((window.innerWidth - 24) / 20) * 20);
      book.readerStyle = { ...currentReaderStyle(), width, sideMargin: 0 };
      await reflowReaderPreservingPosition(applyReaderStyle); await put('books', book);
    };
    $('readerIndentToggle').onchange = e => updateReaderStyle('indent', e.target.checked);
    $('readerThemeSelect').onchange = e => updateReaderStyle('theme', e.target.value);
    $('readerTurnMode').onchange = e => updateReaderStyle('turnMode', e.target.value);
    $('readerGalleryItems').onclick = e => { const button = e.target.closest('[data-gallery-image]'); if (button) showReaderImage(Number(button.dataset.galleryImage)); };
    $('readerStage').onclick = e => { const image = e.target.closest('[data-reader-image]'); if (image) showReaderImage(Number(image.dataset.readerImage)); };
    $('readerStage').addEventListener('wheel', e => {
      markReaderActivity();
      if (currentReaderStyle().turnMode !== 'page' || !state.readerChapters.length) return;
      e.preventDefault(); state.wheelDelta += e.deltaY;
      clearTimeout(state.wheelTimer);
      state.wheelTimer = setTimeout(() => { const delta = state.wheelDelta; state.wheelDelta = 0; if (Math.abs(delta) > 24) moveReaderPage(delta > 0 ? 1 : -1); }, 90);
    }, { passive: false });
    $('txtPreviewBtn').onclick = previewTextChapters; $('txtApplyBtn').onclick = applyTextChapterSettings;
    $('readerImageClose').onclick = () => $('readerLightbox').classList.remove('open');
    $('readerImageScaleToggle').onclick = () => { const original = $('readerLightbox').classList.toggle('original-size'); $('readerImageScaleToggle').textContent = original ? '适应窗口' : '原始尺寸'; };
    $('readerImageLocate').onclick = () => {
      const image = state.readerImages[state.activeImageIndex]; if (!image) return;
      renderChapter(image.chapterIndex); $('readerLightbox').classList.remove('open');
      requestAnimationFrame(() => { $('readerStage').querySelector(`[data-reader-image="${state.activeImageIndex}"]`)?.scrollIntoView({ block: 'center' }); persistReaderPosition(); });
    };
    $('readerImagePrev').onclick = () => showReaderImage(state.activeImageIndex - 1); $('readerImageNext').onclick = () => showReaderImage(state.activeImageIndex + 1);
    $('readerDockToc').onclick = () => $('readerToc').classList.toggle('open');
    $('readerDockNote').onclick = addReaderNote;
    $('readerDockBookmark').onclick = addReaderBookmark;
    const themePicker = $('readerThemePicker');
    const closeThemePicker = () => { themePicker.classList.remove('open'); $('readerDockTheme').setAttribute('aria-expanded', 'false'); $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    $('readerDockTheme').onclick = () => { const open = themePicker.classList.toggle('open'); $('readerDockTheme').setAttribute('aria-expanded', String(open)); if (!open) $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onpointerover = e => { const option = e.target.closest('[data-reader-theme-option]'); if (option) $('readerModal').dataset.readerTheme = option.dataset.readerThemeOption; };
    themePicker.onpointerleave = () => { $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onfocusin = e => { const option = e.target.closest('[data-reader-theme-option]'); if (option) $('readerModal').dataset.readerTheme = option.dataset.readerThemeOption; };
    themePicker.onfocusout = e => { if (!themePicker.contains(e.relatedTarget)) $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onclick = async e => { const option = e.target.closest('[data-reader-theme-option]'); if (!option) return; await updateReaderStyle('theme', option.dataset.readerThemeOption); closeThemePicker(); toast(`已应用“${option.dataset.themeName}”主题。`); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && themePicker.classList.contains('open')) closeThemePicker(); });
    $('readerDockSettings').onclick = () => $('readerSettings').classList.toggle('open');
    $('readerDockSpeak').onclick = toggleReaderSpeech;
    $('readerProgressRange').oninput = e => { const percent = Number(e.target.value) / 10; e.target.style.setProperty('--progress', `${percent}%`); renderSeekPreview(Number(e.target.value)); };
    $('readerProgressRange').onchange = e => renderSeekPreview(Number(e.target.value));
    $('readerSeekCancel').onclick = () => { state.pendingSeekValue = null; $('readerSeekPreview').classList.add('hidden'); updateReaderProgressUI(); };
    $('readerSeekConfirm').onclick = confirmProgressSeek;
    $('readerPositionBack').onclick = navigateReaderBack; $('readerPositionForward').onclick = navigateReaderForward;
    $('readerPositionHistoryToggle').onclick = () => { renderReaderPositionHistory(); $('readerPositionHistory').classList.toggle('open'); };
    $('readerPositionHistoryClose').onclick = () => $('readerPositionHistory').classList.remove('open');
    $('readerPositionHistoryItems').onclick = e => {
      const entryButton = e.target.closest('[data-position-entry]');
      if (entryButton) { const entryId = entryButton.dataset.positionEntry; queueReaderNavigation(async () => { const book = state.readerBook; if (!book) return; const entry = state.navigationService.export(book.id).entries.find(item => item.id === entryId); const target = state.navigationService.restoreEntry(book.id, entry, captureReaderAnchor()); if (target) { await restoreReaderAnchor(target); await persistReaderPosition(true); showReaderUndoNotice(entry?.sourceAnchor, target); renderReaderPositionHistory(); } }); return; }
      const sessionButton = e.target.closest('[data-session-start],[data-session-end]'); if (!sessionButton) return;
      const sessionId = sessionButton.dataset.sessionStart || sessionButton.dataset.sessionEnd, useStart = !!sessionButton.dataset.sessionStart;
      queueReaderNavigation(async () => {
        const book = state.readerBook; if (!book) return;
        const session = state.navigationService.export(book.id).sessions.find(item => item.id === sessionId), target = useStart ? session?.startAnchor : session?.endAnchor;
        if (target) { const from = captureReaderAnchor(); state.navigationService.restoreEntry(book.id, { targetAnchor: target }, from); await restoreReaderAnchor(target); await persistReaderPosition(true); showReaderUndoNotice(from, target); renderReaderPositionHistory(); }
      });
    };
    $('readerProgressPrev').onclick = () => moveReaderPage(-1);
    $('readerProgressNext').onclick = () => moveReaderPage(1);
    $('readerPrev').onclick = () => { if (state.readerChapterIndex > 0) { animateReaderTurn(-1); renderChapter(state.readerChapterIndex - 1); persistReaderPosition(); } };
    $('readerNext').onclick = () => { if (state.readerChapterIndex < state.readerChapters.length - 1) { animateReaderTurn(1); renderChapter(state.readerChapterIndex + 1); persistReaderPosition(); } };
    $('readerTocItems').onclick = e => {
      const item = e.target.closest('[data-chapter-index]'); if (!item) return;
      const target = Number(item.dataset.chapterIndex), chapter = state.readerChapters[target]; if (!chapter) return;
      animateReaderTurn(target >= state.readerChapterIndex ? 1 : -1);
      navigateReaderToAnchor({ fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex: target, chapterTitle: chapter.title, blockIndex: 0, charOffset: 0, sourceOffset: chapter.blocks?.find(block => Number.isFinite(block.sourceOffset))?.sourceOffset ?? null, chapterScrollRatio: 0, progress: target / Math.max(1, state.readerChapters.length) * 100 }, '目录');
    };
    $('fontDown').onclick = () => updateReaderStyle('fontSize', Math.max(14, Number(currentReaderStyle().fontSize) - 1));
    $('fontUp').onclick = () => updateReaderStyle('fontSize', Math.min(30, Number(currentReaderStyle().fontSize) + 1));
  }

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
      const open = e.target.closest('[data-open]'); if (open) openBook(open.dataset.open);
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
    $('importBtn').onclick = $('emptyImportBtn').onclick = $('dropImportBtn').onclick = () => $('fileInput').click();
    $('dashboardImportBtn').onclick = () => $('fileInput').click();
    $('dashboardImportFolderBtn').onclick = () => {
      if (!window.libraDesktop?.isDesktop) { toast('文件夹扫描导入需要 Windows 桌面版。'); return; }
      $('folderImportModal').classList.remove('hidden'); $('folderImportPath').textContent = state.folderImportPath || '尚未选择文件夹';
      $('folderFileList').innerHTML = '<div class="folder-file-empty">选择文件夹后扫描匹配文件。</div>';
      $('folderScanSummary').textContent = '选择文件夹和格式后开始扫描。'; $('folderImportStart').disabled = true;
    };
    $('folderChooseSourceBtn').onclick = async () => {
      try {
        const folder = await window.libraDesktop?.chooseImportFolder(); if (!folder) return;
        state.folderImportPath = folder; $('folderImportPath').textContent = folder; await scanImportFolder();
      } catch (error) { toast(`选择文件夹失败：${error.message || error}`, 'error'); }
    };
    $('folderScanBtn').onclick = scanImportFolder;
    $('folderFileList').onchange = e => { const input = e.target.closest('[data-import-index]'); if (!input) return; const item = state.folderImportItems[Number(input.dataset.importIndex)]; if (item) item.selected = input.checked; renderFolderImportFiles(); };
    $('folderImportStart').onclick = importFolderSelection;
    $('folderImportClose').onclick = $('folderImportCancel').onclick = () => $('folderImportModal').classList.add('hidden');
    $('folderImportModal').onclick = e => { if (e.target === $('folderImportModal')) $('folderImportModal').classList.add('hidden'); };
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
      else if (!$('readerModal').classList.contains('hidden') && !e.target.closest('button,input,textarea,select') && (e.key === 'PageDown' || e.key === 'PageUp')) { markReaderActivity(); e.preventDefault(); moveReaderPage(e.key === 'PageDown' ? 1 : -1); }
      else if (e.key === 'Escape') { if (document.fullscreenElement) return; if ($('readerLightbox').classList.contains('open')) $('readerLightbox').classList.remove('open'); else if ($('readerNotesPanel').classList.contains('open')) $('readerNotesPanel').classList.remove('open'); else if ($('readerSearchPanel').classList.contains('open')) $('readerSearchPanel').classList.remove('open'); else if ($('readerPositionHistory').classList.contains('open')) $('readerPositionHistory').classList.remove('open'); else if (!$('readerModal').classList.contains('hidden')) closeReader(); }
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
