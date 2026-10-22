import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderTabManager } from './tab-manager.js';

test('reader workspace reuses a book tab and enforces its tab limit', () => {
  const tabs = new ReaderTabManager({ maxTabs: 2 });
  const first = tabs.open('a', 'A');
  assert.equal(tabs.open('a', 'A2'), first);
  tabs.open('b', 'B');
  assert.throws(() => tabs.open('c', 'C'), /最多同时打开 2 本书/);
  assert.equal(tabs.tabs.length, 2);
});

test('closing tabs keeps active selection and supports recently closed restore', () => {
  const tabs = new ReaderTabManager();
  tabs.open('a', 'A'); tabs.open('b', 'B'); tabs.open('c', 'C'); tabs.activate('b');
  tabs.close('b');
  assert.equal(tabs.activeBookId, 'c');
  assert.equal(tabs.reopenLastClosed().bookId, 'b');
  assert.equal(tabs.activeBookId, 'b');
});

test('close right, close others and drag reorder preserve a valid active book', () => {
  const tabs = new ReaderTabManager();
  for (const id of ['a', 'b', 'c', 'd']) tabs.open(id, id.toUpperCase());
  tabs.activate('c'); tabs.closeToRight('b');
  assert.deepEqual(tabs.tabs.map(tab => tab.bookId), ['a', 'b']);
  tabs.move('a', 1);
  assert.deepEqual(tabs.tabs.map(tab => tab.bookId), ['b', 'a']);
  tabs.closeOthers('a');
  assert.deepEqual(tabs.tabs.map(tab => tab.bookId), ['a']);
  assert.equal(tabs.activeBookId, 'a');
});

test('restoring a workspace drops deleted and duplicate book references', () => {
  const tabs = new ReaderTabManager();
  tabs.restore({ tabs: [{ bookId: 'a' }, { bookId: 'gone' }, { bookId: 'a' }, { bookId: 'b' }], activeBookId: 'gone' }, new Set(['a', 'b']));
  assert.deepEqual(tabs.tabs.map(tab => tab.bookId), ['a', 'b']);
  assert.equal(tabs.activeBookId, 'b');
});
