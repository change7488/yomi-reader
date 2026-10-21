// Library grid, filters and cover URLs. Keep renderer state behind a small interface.
export function createLibraryView({ state, $, esc, svgCover, folderRouteId, getFolderBooks, folderById, updateSelectionToolbar }) {
  const demos = [
    { id: 'demo-1', title: '夜航西飞', author: '柏瑞尔·马卡姆', ext: 'EPUB', progress: 65, hue: '#b78b57', demo: true },
    { id: 'demo-2', title: '挪威的森林', author: '村上春树', ext: 'EPUB', progress: 0, hue: '#9fa79e', demo: true },
    { id: 'demo-3', title: '人间失格', author: '太宰治', ext: 'PDF', progress: 32, hue: '#397e8a', demo: true }
  ];
  function booksForView() {
    let books = state.books.length ? [...state.books] : demos.map(x => ({ ...x }));
    if (state.route === 'favorites') books = books.filter(b => b.favorite);
    if (state.route === 'history') books = books.filter(b => (b.lastRead || 0) > 0 || b.progress > 0);
    const selectedFolder = folderRouteId();
    if (selectedFolder) { const ids = new Set(getFolderBooks(selectedFolder).map(link => link.bookId)); books = books.filter(book => ids.has(book.id)); }
    if (state.filter === 'reading') books = books.filter(b => b.progress > 0 && b.progress < 100);
    if (state.filter === 'unread') books = books.filter(b => !b.progress);
    if (state.query) { const q = state.query.toLowerCase(); books = books.filter(b => `${b.title} ${b.author} ${b.name}`.toLowerCase().includes(q)); }
    books.sort((a, b) => state.sortRecent ? (b.addedAt || 0) - (a.addedAt || 0) : a.title.localeCompare(b.title, 'zh-CN'));
    return books;
  }
  const coverUrls = new WeakMap();
  function coverSrc(book) {
    if (!book.coverBlob) return svgCover(book.title, book.author, book.hue || '#a8d7bf');
    if (!coverUrls.has(book)) coverUrls.set(book, URL.createObjectURL(book.coverBlob));
    return coverUrls.get(book);
  }
  function renderBooks() {
    const books = booksForView(); $('bookGrid').innerHTML = '';
    $('bookGrid').classList.toggle('list-mode', !!state.listMode);
    for (const book of books) {
      const card = document.createElement('article'); card.className = 'book-card'; card.draggable = !book.demo; card.dataset.bookCard = book.id;
      const cover = coverSrc(book);
      card.innerHTML = `<label class="book-select" title="选择图书"><input type="checkbox" data-book-select="${esc(book.id)}" ${state.selectedBooks.has(book.id) ? 'checked' : ''}><span></span></label><button class="cover-button" data-open="${esc(book.id)}" aria-label="阅读 ${esc(book.title)}"><img class="book-cover" src="${cover}" alt="${esc(book.title)} 封面"/><span class="cover-progress" style="width:${Math.min(100, book.progress || 0)}%"></span></button><div class="book-meta"><div style="min-width:0"><div class="book-title" title="${esc(book.title)}">${esc(book.title)}</div><div class="book-author">${esc(book.author || book.ext?.toUpperCase() || '')}</div></div><span class="book-progress-text">${book.progress ? `已读 ${book.progress}%` : '未开始'}</span></div><div class="card-actions"><button class="card-action ${book.favorite ? 'favorite' : ''}" data-fav="${esc(book.id)}" title="${book.favorite ? '取消喜欢' : '加入喜欢'}">${book.favorite ? '♥' : '♡'}</button>${book.demo ? '' : `<button class="card-action" data-book-menu="${esc(book.id)}" title="图书选项">⋯</button>`}</div>`;
      $('bookGrid').append(card);
    }
    $('allCount').textContent = state.books.length || demos.length;
    const selectedFolder = folderRouteId(), title = selectedFolder ? folderById(selectedFolder)?.name : '';
    $('resultText').textContent = selectedFolder ? `${books.length} 本 · 虚拟文件夹` : state.books.length ? `共 ${state.books.length} 本` : '示例书架 · 导入文件后开始管理';
    const empty = books.length === 0; $('emptyState').classList.toggle('hidden', !empty); $('bookGrid').classList.toggle('hidden', empty);
    if (empty && selectedFolder) { $('emptyState').querySelector('h2').textContent = `「${title || '文件夹'}」还是空的`; $('emptyState').querySelector('p').textContent = '从全部图书中选择书籍，或拖到左侧文件夹即可整理。'; $('emptyImportBtn').classList.add('hidden'); }
    else { $('emptyState').querySelector('h2').textContent = '让好书在这里相遇'; $('emptyState').querySelector('p').textContent = '导入 EPUB、PDF 或 TXT 文件，开始整理你的私人书架。'; $('emptyImportBtn').classList.remove('hidden'); }
    updateSelectionToolbar();
    $('downloadDock').classList.toggle('hidden', ['downloads', 'online', 'public', 'local', 'settings'].includes(state.route));
    const importedCount = state.books.length; $('storageText').textContent = `${importedCount} 本`; $('storageBar').style.width = `${Math.min(100, importedCount * 7)}%`;
  }

  return { booksForView, coverSrc, renderBooks };
}
