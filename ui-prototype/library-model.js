export function folderSubtreeIds(folders, folderId) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) if (ids.has(folder.parentId) && !ids.has(folder.id)) { ids.add(folder.id); changed = true; }
  }
  return ids;
}

export function addFolderLinks(links, folderIds, bookIds, addedAt = Date.now()) {
  const next = new Map(links.map(link => [`${link.folderId}\u0000${link.bookId}`, link]));
  for (const folderId of folderIds) for (const bookId of bookIds) {
    const key = `${folderId}\u0000${bookId}`;
    if (!next.has(key)) next.set(key, { folderId, bookId, addedAt, sortOrder: next.size });
  }
  return [...next.values()];
}

export function removeFolderLinks(links, folderIds, bookIds) {
  const folders = new Set(folderIds), books = new Set(bookIds);
  return links.filter(link => !(folders.has(link.folderId) && books.has(link.bookId)));
}

export function deleteFolderTree(folders, links, folderId) {
  const ids = folderSubtreeIds(folders, folderId);
  return {
    folders: folders.filter(folder => !ids.has(folder.id)),
    links: links.filter(link => !ids.has(link.folderId)),
    deletedFolderIds: ids
  };
}

export function deleteBookEntity(books, links, bookId) {
  return { books: books.filter(book => book.id !== bookId), links: links.filter(link => link.bookId !== bookId) };
}
