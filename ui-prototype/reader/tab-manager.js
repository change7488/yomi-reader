const DEFAULT_MAX_TABS = 10;
const MAX_RECENTLY_CLOSED = 10;

/** Lightweight reader workspace; document data is loaded only for the active tab. */
export class ReaderTabManager {
  constructor({ maxTabs = DEFAULT_MAX_TABS, recentlyClosed = [] } = {}) {
    this.maxTabs = Math.max(1, Math.min(20, Math.floor(maxTabs) || DEFAULT_MAX_TABS));
    this.tabs = [];
    this.activeBookId = null;
    this.recentlyClosed = recentlyClosed.slice(-MAX_RECENTLY_CLOSED);
  }

  open(bookId, title = '') {
    if (typeof bookId !== 'string' || !bookId) throw new TypeError('bookId is required');
    const existing = this.tabs.find(tab => tab.bookId === bookId);
    if (existing) { existing.title = title || existing.title; return existing; }
    if (this.tabs.length >= this.maxTabs) throw new Error(`最多同时打开 ${this.maxTabs} 本书`);
    const tab = { bookId, title: String(title || '未命名图书'), openedAt: Date.now() };
    this.tabs.push(tab);
    this.recentlyClosed = this.recentlyClosed.filter(item => item.bookId !== bookId);
    return tab;
  }

  activate(bookId) {
    if (!this.tabs.some(tab => tab.bookId === bookId)) return false;
    this.activeBookId = bookId;
    return true;
  }

  close(bookId) {
    const index = this.tabs.findIndex(tab => tab.bookId === bookId);
    if (index < 0) return null;
    const [closed] = this.tabs.splice(index, 1);
    this.recentlyClosed = [...this.recentlyClosed.filter(item => item.bookId !== bookId), { ...closed, closedAt: Date.now() }].slice(-MAX_RECENTLY_CLOSED);
    if (this.activeBookId === bookId) this.activeBookId = this.tabs[Math.min(index, this.tabs.length - 1)]?.bookId || null;
    return closed;
  }

  closeOthers(bookId) {
    if (!this.tabs.some(tab => tab.bookId === bookId)) return [];
    const removed = this.tabs.filter(tab => tab.bookId !== bookId).map(tab => this.close(tab.bookId));
    this.activate(bookId);
    return removed;
  }

  closeToRight(bookId) {
    const index = this.tabs.findIndex(tab => tab.bookId === bookId);
    if (index < 0) return [];
    const removed = this.tabs.slice(index + 1).map(tab => this.close(tab.bookId));
    if (!this.activeBookId || !this.tabs.some(tab => tab.bookId === this.activeBookId)) this.activate(bookId);
    return removed;
  }

  move(bookId, targetIndex) {
    const index = this.tabs.findIndex(tab => tab.bookId === bookId);
    if (index < 0) return false;
    const [tab] = this.tabs.splice(index, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, Math.floor(targetIndex))), 0, tab);
    return true;
  }

  reopenLastClosed() {
    const tab = this.recentlyClosed.pop();
    if (!tab || this.tabs.length >= this.maxTabs) return null;
    this.tabs.push({ bookId: tab.bookId, title: tab.title, openedAt: Date.now() });
    this.activeBookId = tab.bookId;
    return tab;
  }

  restore(snapshot, validBookIds) {
    const valid = validBookIds instanceof Set ? validBookIds : new Set(validBookIds || []);
    const seen = new Set();
    this.tabs = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).filter(tab => {
      if (!tab || typeof tab.bookId !== 'string' || !valid.has(tab.bookId) || seen.has(tab.bookId)) return false;
      seen.add(tab.bookId);
      return true;
    }).slice(-this.maxTabs).map(tab => ({ bookId: tab.bookId, title: String(tab.title || '未命名图书'), openedAt: Number(tab.openedAt) || Date.now() }));
    this.recentlyClosed = (Array.isArray(snapshot?.recentlyClosed) ? snapshot.recentlyClosed : [])
      .filter(tab => tab && typeof tab.bookId === 'string' && valid.has(tab.bookId))
      .slice(-MAX_RECENTLY_CLOSED).map(tab => ({ bookId: tab.bookId, title: String(tab.title || '未命名图书'), closedAt: Number(tab.closedAt) || Date.now() }));
    const requested = snapshot?.activeBookId;
    this.activeBookId = this.tabs.some(tab => tab.bookId === requested) ? requested : this.tabs.at(-1)?.bookId || null;
  }

  snapshot() {
    return { tabs: this.tabs.map(tab => ({ ...tab })), activeBookId: this.activeBookId, recentlyClosed: this.recentlyClosed.map(tab => ({ ...tab })) };
  }
}
