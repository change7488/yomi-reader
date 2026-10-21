const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SUPPORTED_EXTENSIONS = new Set(['epub', 'pdf', 'txt']);
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const MAX_SCAN_RESULTS = 20000;

function normalizedExtensions(extensions) {
  return new Set((Array.isArray(extensions) ? extensions : [])
    .map(value => String(value).replace(/^\./, '').toLowerCase())
    .filter(value => SUPPORTED_EXTENSIONS.has(value)));
}

async function scanFolder(rootPath, extensions, minSizeBytes = 0) {
  const root = path.resolve(rootPath);
  const accepted = normalizedExtensions(extensions);
  if (!accepted.size) return [];
  const minimum = Math.max(0, Number(minSizeBytes) || 0);
  const results = [];
  async function walk(folder) {
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= MAX_SCAN_RESULTS) return;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!accepted.has(ext)) continue;
      const stat = await fs.promises.stat(fullPath);
      if (stat.size < minimum || stat.size > MAX_FILE_SIZE || stat.size === 0) continue;
      results.push({ path: fullPath, name: entry.name, ext, size: stat.size, lastModified: stat.mtimeMs,
        relativePath: path.relative(root, fullPath) });
      if (results.length >= MAX_SCAN_RESULTS) return;
    }
  }
  await walk(root);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
}

function validateBookName(name) {
  const safeName = path.basename(String(name || 'book'));
  const ext = path.extname(safeName).slice(1).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) throw new Error('仅支持 EPUB、PDF 和 TXT 文件');
  return { safeName, ext };
}

async function copyBook({ sourcePath, bytes, name, hash, libraryFolder }) {
  const { safeName, ext } = validateBookName(name);
  const digest = String(hash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('书籍校验值无效');
  const destinationFolder = path.resolve(libraryFolder);
  await fs.promises.mkdir(destinationFolder, { recursive: true });
  const destination = path.join(destinationFolder, `${digest}.${ext}`);
  try {
    const existing = await fs.promises.stat(destination);
    if (existing.isFile()) return { path: destination, name: safeName, size: existing.size };
  } catch { /* Copy the book when it is not already in the library. */ }

  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    if (typeof sourcePath === 'string' && sourcePath) {
      const source = path.resolve(sourcePath);
      const stat = await fs.promises.stat(source);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) throw new Error('书籍文件为空或超过 1 GB');
      if (source === destination) return { path: destination, name: safeName, size: stat.size };
      await fs.promises.copyFile(source, temporary);
      if (await hashFile(temporary) !== digest) throw new Error('文件在导入过程中发生变化，请重新扫描后再导入');
      return { path: await publish(), name: safeName, size: stat.size };
    }
    const data = Buffer.from(bytes || []);
    if (!data.length || data.length > MAX_FILE_SIZE) throw new Error('书籍文件为空或超过 1 GB');
    if (crypto.createHash('sha256').update(data).digest('hex') !== digest) throw new Error('文件校验失败，请重新导入');
    await fs.promises.writeFile(temporary, data, { flag: 'wx' });
    return { path: await publish(), name: safeName, size: data.length };
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  async function publish() {
    try { await fs.promises.rename(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await fs.promises.rm(temporary, { force: true });
    }
    return destination;
  }
}

async function stageLibraryBookForDeletion({ filePath, hash, ext, libraryFolder }) {
  const digest = String(hash || '').toLowerCase(), extension = String(ext || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest) || !SUPPORTED_EXTENSIONS.has(extension)) throw new Error('书目校验值或格式无效');
  const root = path.resolve(libraryFolder), target = path.resolve(filePath), expected = path.join(root, `${digest}.${extension}`);
  if (target !== expected || !isWithinFolder(root, target)) throw new Error('文件路径不符合软件书库的文件所有权规则');
  const stat = await fs.promises.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_SIZE) throw new Error('目标不是有效的书库普通文件');
  if (await hashFile(target) !== digest) throw new Error('文件内容与书目校验值不一致，已阻止删除');
  const stagedPath = path.join(root, `.${digest}.${crypto.randomUUID()}.pending-delete`);
  await fs.promises.rename(target, stagedPath);
  if (await hashFile(stagedPath) !== digest) {
    await fs.promises.rename(stagedPath, target).catch(() => {});
    throw new Error('暂存期间文件内容发生变化，已恢复原路径并取消删除');
  }
  return { stagedPath };
}

function stagedBookIdentity(stagedPath, libraryFolder) {
  const root = path.resolve(libraryFolder), target = path.resolve(stagedPath), match = /^\.([a-f0-9]{64})\.([0-9a-f-]+)\.pending-delete$/i.exec(path.basename(target));
  if (!match || !isWithinFolder(root, target)) throw new Error('暂存文件路径无效');
  return { root, target, hash: match[1].toLowerCase() };
}

async function restoreStagedLibraryBook({ stagedPath, originalPath, libraryFolder }) {
  const { root, target, hash } = stagedBookIdentity(stagedPath, libraryFolder), original = path.resolve(originalPath);
  if (!isWithinFolder(root, original) || !new RegExp(`^${hash}\\.(epub|pdf|txt)$`, 'i').test(path.basename(original))) throw new Error('恢复路径不符合书库安全规则');
  const stat = await fs.promises.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || await hashFile(target) !== hash) throw new Error('暂存文件内容校验失败，已保留文件');
  try { await fs.promises.lstat(original); throw new Error(`原路径已存在其他文件，已保留暂存文件：${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.promises.rename(target, original); return true;
}

async function verifyStagedLibraryBook(stagedPath, libraryFolder) {
  const { target, hash } = stagedBookIdentity(stagedPath, libraryFolder), stat = await fs.promises.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || await hashFile(target) !== hash) throw new Error('暂存文件内容校验失败，已阻止回收');
  return target;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), input = fs.createReadStream(filePath); let digest;
    input.on('error', reject); input.on('data', chunk => hash.update(chunk)); input.on('end', () => { digest = hash.digest('hex'); });
    input.on('close', () => { if (digest) resolve(digest); });
  });
}

function isWithinFolder(folder, target) {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

module.exports = { MAX_FILE_SIZE, SUPPORTED_EXTENSIONS, copyBook, hashFile, isWithinFolder, restoreStagedLibraryBook, scanFolder, stageLibraryBookForDeletion, verifyStagedLibraryBook };
