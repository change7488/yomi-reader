const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyBook, isWithinFolder, restoreStagedLibraryBook, scanFolder, stageLibraryBookForDeletion, verifyStagedLibraryBook } = require('./library-storage.cjs');

async function withTempFolder(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'libra-library-'));
  try { await run(folder); } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); break; }
      catch (error) { if (error.code !== 'ENOTEMPTY' || attempt === 4) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  }
}

test('scans selected formats recursively and honors minimum file size', async () => {
  await withTempFolder(async root => {
    await fs.mkdir(path.join(root, 'subfolder'));
    await fs.writeFile(path.join(root, 'small.txt'), 'x');
    await fs.writeFile(path.join(root, 'subfolder', 'novel.epub'), 'long enough');
    await fs.writeFile(path.join(root, 'subfolder', 'ignore.pdf'), 'pdf');
    const results = await scanFolder(root, ['epub'], 4);
    assert.deepEqual(results.map(item => item.relativePath), [path.join('subfolder', 'novel.epub')]);
  });
});

test('copies a book into the managed folder and rejects a mismatched hash', async () => {
  await withTempFolder(async root => {
    const source = path.join(root, 'source.txt'), library = path.join(root, 'library'), bytes = Buffer.from('light novel');
    await fs.writeFile(source, bytes);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = await copyBook({ sourcePath: source, name: 'novel.txt', hash, libraryFolder: library });
    assert.equal(await fs.readFile(stored.path, 'utf8'), 'light novel');
    assert.equal(isWithinFolder(library, stored.path), true);
    await fs.rm(source);
    assert.equal(await fs.readFile(stored.path, 'utf8'), 'light novel');
    await assert.rejects(copyBook({ bytes: Buffer.from('changed'), name: 'bad.epub', hash, libraryFolder: library }), /校验失败/);
  });
});

test('stages only the owned book file and restores it without touching neighboring books', async () => {
  await withTempFolder(async root => {
    const library = path.join(root, 'library'); await fs.mkdir(library);
    const bytes = Buffer.from('owned novel'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const target = path.join(library, `${hash}.txt`), other = path.join(library, 'other.pdf');
    await fs.writeFile(target, bytes); await fs.writeFile(other, 'keep this file');
    const { stagedPath } = await stageLibraryBookForDeletion({ filePath: target, hash, ext: 'txt', libraryFolder: library });
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    assert.equal(await fs.readFile(await verifyStagedLibraryBook(stagedPath, library), 'utf8'), 'owned novel');
    assert.equal(await fs.readFile(other, 'utf8'), 'keep this file');
    await restoreStagedLibraryBook({ stagedPath, originalPath: target, libraryFolder: library });
    assert.equal(await fs.readFile(target, 'utf8'), 'owned novel');
    assert.equal(await fs.readFile(other, 'utf8'), 'keep this file');
  });
});

test('refuses to stage a path outside the managed folder or with a mismatched file hash', async () => {
  await withTempFolder(async root => {
    const library = path.join(root, 'library'), outside = path.join(root, 'outside.txt'); await fs.mkdir(library);
    const bytes = Buffer.from('expected'), hash = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(library, `${hash}.txt`), 'different bytes'); await fs.writeFile(outside, bytes);
    await assert.rejects(stageLibraryBookForDeletion({ filePath: outside, hash, ext: 'txt', libraryFolder: library }), /所有权规则/);
    await assert.rejects(stageLibraryBookForDeletion({ filePath: path.join(library, `${hash}.txt`), hash, ext: 'txt', libraryFolder: library }), /校验值不一致/);
    assert.equal(await fs.readFile(outside, 'utf8'), 'expected');
  });
});
