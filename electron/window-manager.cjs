function isAlive(window) {
  return Boolean(window && !window.isDestroyed());
}

function focus(window) {
  if (!isAlive(window)) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

/** Owns the single library window and the shared multi-tab reader workspace. */
class WindowManager {
  constructor({ createMainWindow, createReaderWindow, sendBookToReader, onQuit }) {
    this.createMainWindow = createMainWindow;
    this.createReaderWindow = createReaderWindow;
    this.sendBookToReader = sendBookToReader;
    this.onQuit = onQuit;
    this.mainWindow = null;
    this.readerWindow = null;
    this.quitRequested = false;
  }

  openMain() {
    if (focus(this.mainWindow)) return this.mainWindow;
    if (this.quitRequested) return null;
    const window = this.createMainWindow();
    this.mainWindow = window;
    window.once('closed', () => {
      if (this.mainWindow === window) this.mainWindow = null;
    });
    return window;
  }

  openReader(bookId) {
    if (this.quitRequested) return null;
    if (isAlive(this.readerWindow)) {
      this.sendBookToReader(this.readerWindow, bookId);
      focus(this.readerWindow);
      return this.readerWindow;
    }
    const window = this.createReaderWindow(bookId);
    this.readerWindow = window;
    window.once('closed', () => {
      if (this.readerWindow !== window) return;
      this.readerWindow = null;
      if (!this.quitRequested && !isAlive(this.mainWindow)) this.openMain();
    });
    return window;
  }

  focusMain() {
    return focus(this.mainWindow) || Boolean(this.openMain());
  }

  handleAllWindowsClosed() {
    if (!isAlive(this.mainWindow) && !isAlive(this.readerWindow) && !this.quitRequested) this.onQuit();
  }

  requestQuit() {
    this.quitRequested = true;
    return this.readerWindow;
  }
}

module.exports = { WindowManager };
