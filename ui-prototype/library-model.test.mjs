import test from 'node:test';
import assert from 'node:assert/strict';
import { addFolderLinks, deleteBookEntity, deleteFolderTree, folderSubtreeIds, removeFolderLinks } from './library-model.js';

const folders = [
  { id: 'a', parentId: null },
  { id: 'a1', parentId: 'a' },
  { id: 'a2', parentId: 'a1' },
  { id: 'b', parentId: null }
];

test('a book can be linked to multiple folders without duplicating book entities', () => {
  const books = [{ id: 'book-1', filePath: 'one-copy.epub' }];
  const links = addFolderLinks([], ['a', 'b'], ['book-1'], 123);
  assert.equal(books.length, 1);
  assert.deepEqual(links.map(link => [link.folderId, link.bookId]), [['a', 'book-1'], ['b', 'book-1']]);
  assert.equal(addFolderLinks(links, ['a'], ['book-1']).length, 2);
});

test('removing a link from folder A preserves folder B and book entity', () => {
  const books = [{ id: 'book-1' }], links = addFolderLinks([], ['a', 'b'], ['book-1']);
  const remaining = removeFolderLinks(links, ['a'], ['book-1']);
  assert.deepEqual(remaining.map(link => link.folderId), ['b']);
  assert.equal(books.length, 1);
});

test('deleting a folder subtree only removes its links and leaves all books intact', () => {
  const books = [{ id: 'book-1' }, { id: 'book-2' }];
  const links = addFolderLinks([], ['a', 'a1', 'b'], ['book-1']);
  const result = deleteFolderTree(folders, links, 'a');
  assert.deepEqual([...result.deletedFolderIds].sort(), ['a', 'a1', 'a2']);
  assert.deepEqual(result.folders.map(folder => folder.id), ['b']);
  assert.deepEqual(result.links.map(link => link.folderId), ['b']);
  assert.equal(books.length, 2);
});

test('deleting a book entity removes every folder reference', () => {
  const books = [{ id: 'book-1' }, { id: 'book-2' }], links = addFolderLinks([], ['a', 'b'], ['book-1']);
  const result = deleteBookEntity(books, links, 'book-1');
  assert.deepEqual(result.books.map(book => book.id), ['book-2']);
  assert.deepEqual(result.links, []);
});

test('folder subtree lookup includes every descendant and excludes siblings', () => {
  assert.deepEqual([...folderSubtreeIds(folders, 'a1')].sort(), ['a1', 'a2']);
});
