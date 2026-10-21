// IndexedDB storage adapter; keeps database schema and migrations in one place.
// Avoid renaming the database: existing users' shelves and reading progress live here.
export function openLibraryDatabase(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 4);
      req.onupgradeneeded = event => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('customFonts')) db.createObjectStore('customFonts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
        let readingStates;
        if (!db.objectStoreNames.contains('readingStates')) readingStates = db.createObjectStore('readingStates', { keyPath: 'bookId' });
        else readingStates = event.currentTarget.transaction.objectStore('readingStates');
        if (!readingStates.indexNames.contains('byUpdatedAt')) readingStates.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
        let folderBooks;
        if (!db.objectStoreNames.contains('folderBooks')) folderBooks = db.createObjectStore('folderBooks', { keyPath: ['folderId', 'bookId'] });
        else folderBooks = event.currentTarget.transaction.objectStore('folderBooks');
        if (!folderBooks.indexNames.contains('byFolder')) folderBooks.createIndex('byFolder', 'folderId', { unique: false });
        if (!folderBooks.indexNames.contains('byBook')) folderBooks.createIndex('byBook', 'bookId', { unique: false });
        if (event.oldVersion < 2) {
          const cursorRequest = event.currentTarget.transaction.objectStore('books').openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result; if (!cursor) return;
            const book = cursor.value;
            if (!book.storageMode) { book.storageMode = book.nativePath ? 'managed' : 'indexeddb'; cursor.update(book); }
            cursor.continue();
          };
        }
        if (event.oldVersion < 3) {
          const cursorRequest = event.currentTarget.transaction.objectStore('books').openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result; if (!cursor) return;
            const book = cursor.value;
            if (book.readingState) readingStates.put({ bookId: book.id, ...book.readingState });
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

export function createDatabaseQueries(getDatabase) {
  function dbRequest(store, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = getDatabase().transaction(store, mode), req = action(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const all = (store) => dbRequest(store, 'readonly', (s) => s.getAll());
  const put = (store, item) => dbRequest(store, 'readwrite', (s) => s.put(item));
  return { dbRequest, all, put };
}
