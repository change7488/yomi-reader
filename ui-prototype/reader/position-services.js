const copy = value => value == null ? value : structuredClone(value);

export function advanceReadingState(previous = {}, anchor, timestamp = Date.now()) {
  const progress = Math.max(0, Math.min(100, Number(anchor?.progress) || 0));
  const furthestProgress = Math.max(Number(previous.furthestProgress) || 0, progress);
  return {
    ...previous,
    currentAnchor: copy(anchor),
    currentProgress: progress,
    furthestAnchor: progress >= (Number(previous.furthestProgress) || 0) ? copy(anchor) : copy(previous.furthestAnchor),
    furthestProgress,
    updatedAt: timestamp
  };
}

/** Debounces current-position writes and serializes writes per book. */
export class ReadingPositionService {
  constructor({ persist, debounceMs = 2500, onError = () => {} }) {
    if (typeof persist !== 'function') throw new TypeError('persist must be a function');
    this.persist = persist;
    this.debounceMs = debounceMs;
    this.onError = onError;
    this.pending = new Map();
    this.timers = new Map();
    this.chains = new Map();
  }

  schedule(bookId, snapshot) {
    this.pending.set(bookId, copy(snapshot));
    clearTimeout(this.timers.get(bookId));
    this.timers.set(bookId, setTimeout(() => {
      this.timers.delete(bookId);
      this.flush(bookId).catch(error => this.onError(error, bookId));
    }, this.debounceMs));
  }

  async flush(bookId) {
    clearTimeout(this.timers.get(bookId)); this.timers.delete(bookId);
    const snapshot = this.pending.get(bookId);
    if (!snapshot) return this.chains.get(bookId);
    this.pending.delete(bookId);
    const previous = this.chains.get(bookId) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => this.persist(bookId, copy(snapshot)));
    this.chains.set(bookId, write);
    try { await write; }
    catch (error) { if (!this.pending.has(bookId)) this.pending.set(bookId, snapshot); throw error; }
    finally { if (this.chains.get(bookId) === write) this.chains.delete(bookId); }
    if (this.pending.has(bookId)) return this.flush(bookId);
  }

  async flushAll() {
    const ids = new Set([...this.pending.keys(), ...this.chains.keys()]);
    await Promise.all([...ids].map(id => this.flush(id).catch(error => this.onError(error, id))));
  }
}

function samePosition(left, right, threshold = 32) {
  if (!left || !right) return false;
  if (left.fileHash && right.fileHash && left.fileHash !== right.fileHash) return false;
  if (Number.isFinite(left.sourceOffset) && Number.isFinite(right.sourceOffset)) return Math.abs(left.sourceOffset - right.sourceOffset) < threshold;
  const sameChapter = left.chapterId === right.chapterId || left.chapterIndex === right.chapterIndex;
  return sameChapter && left.blockIndex === right.blockIndex && Math.abs((left.charOffset || 0) - (right.charOffset || 0)) < threshold;
}

/** Keeps important jumps separately from ordinary reading movement. */
export class NavigationHistoryService {
  constructor({ limit = 50, dedupeWindowMs = 1200 } = {}) {
    this.limit = limit;
    this.dedupeWindowMs = dedupeWindowMs;
    this.books = new Map();
  }

  load(bookId, saved = {}) {
    const state = {
      entries: Array.isArray(saved.entries) ? saved.entries.slice(-this.limit) : [],
      undoStack: Array.isArray(saved.undoStack) ? saved.undoStack.slice(-this.limit) : [],
      redoStack: Array.isArray(saved.redoStack) ? saved.redoStack.slice(-this.limit) : [],
      sessions: Array.isArray(saved.sessions) ? saved.sessions.slice(-10) : []
    };
    this.books.set(bookId, state);
    return this.export(bookId);
  }

  state(bookId) {
    if (!this.books.has(bookId)) this.load(bookId);
    return this.books.get(bookId);
  }

  export(bookId) { return copy(this.state(bookId)); }

  recordJump(bookId, from, to, eventType, timestamp = Date.now()) {
    if (samePosition(from, to)) return null;
    const state = this.state(bookId), last = state.entries.at(-1);
    if (last && timestamp - last.createdAt <= this.dedupeWindowMs && last.eventType === eventType && samePosition(last.targetAnchor, to)) {
      last.createdAt = timestamp; last.targetAnchor = copy(to); state.undoStack[state.undoStack.length - 1] = copy(from);
      return copy(last);
    }
    const entry = { id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`, sourceAnchor: copy(from), targetAnchor: copy(to), eventType, createdAt: timestamp };
    state.entries.push(entry); if (state.entries.length > this.limit) state.entries.splice(0, state.entries.length - this.limit);
    state.undoStack.push(copy(from)); if (state.undoStack.length > this.limit) state.undoStack.shift();
    state.redoStack = [];
    return copy(entry);
  }

  back(bookId, currentAnchor) {
    const state = this.state(bookId), target = state.undoStack.pop();
    if (!target) return null;
    state.redoStack.push(copy(currentAnchor)); if (state.redoStack.length > this.limit) state.redoStack.shift();
    return copy(target);
  }

  forward(bookId, currentAnchor) {
    const state = this.state(bookId), target = state.redoStack.pop();
    if (!target) return null;
    state.undoStack.push(copy(currentAnchor)); if (state.undoStack.length > this.limit) state.undoStack.shift();
    return copy(target);
  }

  restoreEntry(bookId, entry, currentAnchor) {
    if (!entry?.targetAnchor || samePosition(entry.targetAnchor, currentAnchor)) return null;
    const state = this.state(bookId); state.undoStack.push(copy(currentAnchor));
    if (state.undoStack.length > this.limit) state.undoStack.shift();
    state.redoStack = [];
    return copy(entry.targetAnchor);
  }

  beginSession(bookId, startAnchor, timestamp = Date.now()) {
    const state = this.state(bookId), session = { id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`, startAnchor: copy(startAnchor), endAnchor: copy(startAnchor), startedAt: timestamp, endedAt: null };
    const active = state.sessions.find(item => !item.endedAt);
    if (active) { active.endAnchor = copy(startAnchor); active.endedAt = timestamp; }
    state.sessions.push(session); if (state.sessions.length > 10) state.sessions.splice(0, state.sessions.length - 10);
    return copy(session);
  }

  endSession(bookId, sessionId, endAnchor, timestamp = Date.now()) {
    const session = this.state(bookId).sessions.find(item => item.id === sessionId);
    if (!session) return null;
    session.endAnchor = copy(endAnchor); session.endedAt = timestamp;
    return copy(session);
  }
}
