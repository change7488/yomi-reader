import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceReadingState, NavigationHistoryService, ReadingPositionService } from './position-services.js';

const anchor = (sourceOffset, progress) => ({ fileHash: 'stable-hash', chapterId: 'chapter-1', chapterIndex: 0, blockIndex: 4, charOffset: sourceOffset, sourceOffset, progress });

test('one hundred ordinary position updates collapse into one persistence write', async () => {
  const writes = [];
  const service = new ReadingPositionService({ persist: async (id, value) => writes.push([id, value]), debounceMs: 10 });
  const history = new NavigationHistoryService(); history.load('book');
  for (let index = 1; index <= 100; index++) service.schedule('book', { current: anchor(index * 500, index / 2) });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].current.sourceOffset, 50000);
  assert.equal(history.export('book').entries.length, 0);
});

test('newer snapshots persist after an older in-flight write without being overwritten', async () => {
  const writes = [], gate = {}; gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  const service = new ReadingPositionService({ persist: async (_id, value) => { writes.push(value); if (writes.length === 1) await gate.promise; }, debounceMs: 1000 });
  service.schedule('book', { version: 1 }); const first = service.flush('book');
  await Promise.resolve(); service.schedule('book', { version: 2 }); const second = service.flush('book');
  gate.resolve(); await Promise.all([first, second]);
  assert.deepEqual(writes.map(value => value.version), [1, 2]);
});

test('furthest progress stays monotonic while current position can move backward', () => {
  const furthest = advanceReadingState({}, anchor(650, 65), 1);
  const returned = advanceReadingState(furthest, anchor(210, 21), 2);
  assert.equal(returned.currentProgress, 21);
  assert.equal(returned.furthestProgress, 65);
  assert.equal(returned.furthestAnchor.sourceOffset, 650);
});

test('navigation supports undo, redo and new-branch invalidation', () => {
  const history = new NavigationHistoryService(); history.load('book');
  const a = anchor(100, 10), b = anchor(300, 30), c = anchor(500, 50);
  history.recordJump('book', a, b, 'toc', 1000);
  assert.deepEqual(history.back('book', b), a);
  assert.deepEqual(history.forward('book', a), b);
  history.back('book', b);
  history.recordJump('book', a, c, 'bookmark', 3000);
  assert.equal(history.forward('book', c), null);
});

test('history de-duplicates nearby jumps and retains only its configured limit', () => {
  const history = new NavigationHistoryService({ limit: 50 }); history.load('book');
  const start = anchor(100, 10);
  assert.ok(history.recordJump('book', start, anchor(500, 50), 'progress', 1000));
  history.recordJump('book', start, anchor(520, 52), 'progress', 1500);
  assert.equal(history.export('book').entries.length, 1);
  for (let index = 0; index < 60; index++) history.recordJump('book', anchor(index * 1000, index), anchor(index * 1000 + 300, index + 1), `event-${index}`, 10000 + index * 2000);
  assert.equal(history.export('book').entries.length, 50);
});

test('sessions retain a bounded start and end for cross-session recovery', () => {
  const history = new NavigationHistoryService(); history.load('book');
  const session = history.beginSession('book', anchor(0, 0), 1);
  history.endSession('book', session.id, anchor(100, 10), 2);
  assert.equal(history.export('book').sessions[0].startAnchor.sourceOffset, 0);
  assert.equal(history.export('book').sessions[0].endAnchor.sourceOffset, 100);
});

test('exported navigation state can be restored after an app restart', () => {
  const beforeRestart = new NavigationHistoryService(); beforeRestart.load('book');
  const start = anchor(100, 10), target = anchor(900, 90);
  beforeRestart.recordJump('book', start, target, '目录', 1000);
  beforeRestart.back('book', target);
  const afterRestart = new NavigationHistoryService(); afterRestart.load('book', beforeRestart.export('book'));
  assert.deepEqual(afterRestart.state('book'), beforeRestart.state('book'));
  assert.deepEqual(afterRestart.forward('book', start), target);
});
