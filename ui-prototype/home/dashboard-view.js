// Homepage presentation only: no book parser or database logic.
export function createDashboardView({ state, $, esc, coverSrc, navigate, renderReadingAnalytics }) {
  function renderDashboard() {
    const books = [...state.books].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const reading = [...state.books].filter(b => (b.progress || 0) > 0 && (b.progress || 0) < 100).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0));
    const lastRead = [...state.books].filter(b => b.lastRead || b.progress).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0))[0];
    const hero = $('continueCard');
    if (lastRead) {
      hero.innerHTML = `<div class="continue-copy"><span class="section-kicker"><i></i> CONTINUE READING</span><h2>${esc(lastRead.title)}</h2><p>${esc(lastRead.lastChapterTitle || lastRead.author || '继续阅读')}</p><div class="progress-row"><span class="progress-track"><i style="width:${Math.max(2,lastRead.progress || 0)}%"></i></span><span>已读 ${lastRead.progress || 0}%</span></div><button class="primary-button" data-open="${esc(lastRead.id)}">继续阅读 <b>→</b></button></div><button class="continue-cover" data-open="${esc(lastRead.id)}"><img src="${coverSrc(lastRead)}" alt="${esc(lastRead.title)} 封面"></button><div class="continue-orbit"></div>`;
    } else {
      hero.innerHTML = `<div class="continue-copy"><span class="section-kicker"><i></i> YOUR NEXT STORY</span><h2>${books.length ? '挑一本书，开始阅读' : '为你的书架添上第一本书'}</h2><p>${books.length ? '打开书库，选择想读的故事。' : '导入 EPUB、PDF 或 TXT，建立你的私人阅读空间。'}</p><button class="primary-button" id="heroImportBtn">${books.length ? '浏览我的书库' : '导入第一本书'} <b>→</b></button></div><div class="hero-empty-art"><span>读</span><i>✦</i><b>✧</b></div><div class="continue-orbit"></div>`;
      const action = $('heroImportBtn'); if (action) action.onclick = () => books.length ? navigate('all') : $('fileInput').click();
    }
    $('dashboardStats').innerHTML = `<article class="overview-card"><span class="overview-icon">▤</span><div><strong>${state.books.length}</strong><span>书库藏书</span></div></article><article class="overview-card"><span class="overview-icon">◷</span><div><strong>${reading.length}</strong><span>正在阅读</span></div></article><article class="overview-card"><span class="overview-icon">✓</span><div><strong>${state.books.filter(b => b.progress >= 100).length}</strong><span>已经读完</span></div></article><article class="overview-card"><span class="overview-icon">♡</span><div><strong>${state.books.filter(b => b.favorite).length}</strong><span>我的收藏</span></div></article>`;
    $('recentBooks').innerHTML = books.length ? books.slice(0, 3).map(b => `<button class="recent-book" data-open="${esc(b.id)}"><span class="recent-cover"><img src="${coverSrc(b)}" alt="${esc(b.title)} 封面"></span><span class="recent-book-title">${esc(b.title)}</span><span class="recent-book-author">${esc(b.author || b.ext.toUpperCase())}</span><span class="recent-book-progress">${b.progress ? `已读 ${b.progress}%` : '尚未阅读'}</span></button>`).join('') : `<div class="dashboard-empty"><span class="empty-mark">＋</span><div><strong>书架还空着</strong><p>导入一本本地电子书，它会出现在这里。</p></div><button class="text-button" id="recentImportBtn">选择文件 <b>→</b></button></div>`;
    const history = [...state.books].filter(b => b.lastRead || b.progress).sort((a, b) => (b.lastRead || 0) - (a.lastRead || 0)).slice(0, 3);
    $('recentReading').innerHTML = history.length ? history.map(b => `<button class="history-book" data-open="${esc(b.id)}"><img src="${coverSrc(b)}" alt=""><span><strong>${esc(b.title)}</strong><small>${b.progress || 0}% · ${esc(b.author || '继续阅读')}</small></span><b>→</b></button>`).join('') : `<div class="history-empty">${state.books.length ? '阅读后，最近打开的书会显示在这里。' : '你的阅读记录会显示在这里。'}</div>`;
    const recentImport = $('recentImportBtn'); if (recentImport) recentImport.onclick = () => $('fileInput').click();
    renderReadingAnalytics();
  }

  return { renderDashboard };
}
