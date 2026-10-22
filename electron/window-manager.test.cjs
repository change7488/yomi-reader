const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WindowManager } = require('./window-manager.cjs');

class FakeWindow extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.minimized = false; this.visible = false; this.focused = false; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.visible = true; }
  focus() { this.focused = true; }
  close() { this.destroyed = true; this.emit('closed'); }
}

function fixture() {
  const created = { main: [], reader: [], opens: [], quit: 0 };
  const manager = new WindowManager({
    createMainWindow: () => { const window = new FakeWindow(); created.main.push(window); return window; },
    createReaderWindow: id => { created.opens.push(id); const window = new FakeWindow(); created.reader.push(window); return window; },
    sendBookToReader: (_window, id) => created.opens.push(id),
    onQuit: () => { created.quit++; }
  });
  return { manager, created };
}

test('library closing does not quit while the reader workspace remains open', () => {
  const { manager, created } = fixture();
  manager.openMain(); manager.openReader('book-a'); manager.mainWindow.close();
  manager.handleAllWindowsClosed();
  assert.equal(created.quit, 0);
  assert.equal(manager.readerWindow, created.reader[0]);
});

test('opening books reuses one reader window and focuses an existing main window', () => {
  const { manager, created } = fixture();
  const main = manager.openMain(); main.minimized = true;
  manager.focusMain();
  manager.openReader('book-a'); manager.openReader('book-b');
  assert.equal(created.main.length, 1);
  assert.equal(main.visible, true);
  assert.equal(created.reader.length, 1);
  assert.deepEqual(created.opens, ['book-a', 'book-b']);
});

test('closing the reader recreates the library if it was closed first', () => {
  const { manager, created } = fixture();
  manager.openReader('book-a');
  created.reader[0].close();
  assert.equal(created.main.length, 1);
  assert.equal(manager.mainWindow, created.main[0]);
});

test('closing the last application window requests exit once the manager is notified', () => {
  const { manager, created } = fixture();
  manager.openMain().close();
  manager.handleAllWindowsClosed();
  assert.equal(created.quit, 1);
});
