// Local, foreground-only reading statistics.
export function createReadingAnalytics({ state, $, esc, put }) {
  function localDateKey(date = new Date()) { const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
  function formatReadTime(seconds) { const minutes = Math.floor((seconds || 0) / 60); if (seconds > 0 && minutes === 0) return '不足 1 分钟'; return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`; }
  function installAnalyticsSection() {
    $('dashboardStats').insertAdjacentHTML('afterend', '<section class="reading-analytics" id="readingAnalytics"><div class="analytics-heading"><div><p class="eyebrow">YOUR READING INSIGHTS</p><h2>阅读数据</h2><span>按本机活跃阅读时间统计</span></div><span class="analytics-period">最近 7 天</span></div><div class="analytics-content"><div class="weekly-chart-card"><div class="chart-summary"><span>本周阅读时长</span><strong id="weeklyReadTotal">0 分钟</strong></div><div class="weekly-bars" id="weeklyReadingBars"></div></div><div class="analytics-highlights" id="readingHighlights"></div></div><p class="analytics-footnote">仅在阅读窗口前台且近期有操作时计时；此版本开始累计，不补算历史时长。</p></section>');
  }
  function renderReadingAnalytics() {
    const analytics = state.readingAnalytics || { days: {}, books: {} }, today = new Date();
    const days = Array.from({ length: 7 }, (_, i) => { const date = new Date(today); date.setDate(today.getDate() - (6 - i)); const key = localDateKey(date); return { date, key, ...(analytics.days[key] || {}) }; });
    const totalSeconds = days.reduce((sum, day) => sum + (day.seconds || 0), 0), maxSeconds = Math.max(1, ...days.map(day => day.seconds || 0));
    $('weeklyReadTotal').textContent = formatReadTime(totalSeconds);
    $('weeklyReadingBars').innerHTML = days.map(day => { const minutes = Math.floor((day.seconds || 0) / 60), height = day.seconds ? Math.max(6, (day.seconds / maxSeconds) * 100) : 3; const label = day.date.toLocaleDateString('zh-CN', { weekday: 'short' }); return `<div class="weekly-bar-column" title="${day.date.toLocaleDateString('zh-CN')} · ${formatReadTime(day.seconds || 0)}"><span class="weekly-bar-value">${minutes ? `${minutes}分` : ''}</span><div class="weekly-bar-track"><i style="height:${height}%"></i></div><small>${label}</small></div>`; }).join('');
    const activeDays = days.filter(day => (day.seconds || 0) >= 60).length, weekPageTurns = days.reduce((sum, day) => sum + (day.pageTurns || 0), 0);
    let streak = 0, cursor = new Date(today); if ((analytics.days[localDateKey(cursor)]?.seconds || 0) < 60) cursor.setDate(cursor.getDate() - 1);
    while (streak < 365) { const key = localDateKey(cursor); if ((analytics.days[key]?.seconds || 0) < 60) break; streak++; cursor.setDate(cursor.getDate() - 1); }
    const topBook = Object.values(analytics.books || {}).sort((a, b) => (b.seconds || 0) - (a.seconds || 0))[0];
    $('readingHighlights').innerHTML = `<article class="analytics-highlight"><span>连续阅读</span><strong>${streak}<small> 天</small></strong><i>连续有阅读记录的天数</i></article><article class="analytics-highlight"><span>活跃天数</span><strong>${activeDays}<small> / 7 天</small></strong><i>最近一周有阅读的天数</i></article><article class="analytics-highlight"><span>本周翻页</span><strong>${weekPageTurns}<small> 页</small></strong><i>滚轮、键盘和翻页按钮</i></article><article class="analytics-highlight top-read-book"><span>最常阅读</span><strong title="${esc(topBook?.title || '')}">${esc(topBook?.title || '开始阅读后生成')}</strong><i>${topBook ? `累计 ${formatReadTime(topBook.seconds)}` : '从现在开始记录'}</i></article>`;
  }
  async function saveReadingAnalytics() { await put('settings', { key: 'readingAnalytics', value: state.readingAnalytics }); }
  function markReaderActivity() { state.readerLastActivity = Date.now(); }
  async function trackActiveReading() {
    const now = Date.now(), elapsed = Math.min(30, Math.max(0, Math.floor((now - state.analyticsLastTick) / 1000))); state.analyticsLastTick = now;
    if (!state.readerBook || $('readerModal').classList.contains('hidden') || document.visibilityState !== 'visible' || !document.hasFocus() || now - state.readerLastActivity > 5 * 60 * 1000 || elapsed < 1) return;
    const dayKey = localDateKey(new Date(now)), days = state.readingAnalytics.days || (state.readingAnalytics.days = {}), books = state.readingAnalytics.books || (state.readingAnalytics.books = {});
    const day = days[dayKey] || (days[dayKey] = { seconds: 0, pageTurns: 0 }); day.seconds = (day.seconds || 0) + elapsed;
    const record = books[state.readerBook.id] || (books[state.readerBook.id] = { title: state.readerBook.title, seconds: 0 }); record.title = state.readerBook.title; record.seconds = (record.seconds || 0) + elapsed;
    try { await saveReadingAnalytics(); } catch (error) { console.warn('保存阅读统计失败', error); }
  }
  async function recordPageTurn() {
    if (!state.readerBook) return;
    markReaderActivity(); const key = localDateKey(), days = state.readingAnalytics.days || (state.readingAnalytics.days = {}), day = days[key] || (days[key] = { seconds: 0, pageTurns: 0 });
    day.pageTurns = (day.pageTurns || 0) + 1;
    try { await saveReadingAnalytics(); } catch (error) { console.warn('保存翻页统计失败', error); }
  }

  return { installAnalyticsSection, renderReadingAnalytics, markReaderActivity, trackActiveReading, recordPageTurn };
}
