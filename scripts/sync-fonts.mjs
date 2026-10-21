// Downloads the pinned OFL font bundle at build time, keeping Git history lean.
// Runs on Windows and Android builds; already cached fonts work without network.
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const catalog = JSON.parse(await readFile(join(root, 'ui-prototype/fonts/catalog.json'), 'utf8'));
const destination = join(root, 'ui-prototype/fonts/builtin');
const licenseDir = join(root, 'ui-prototype/fonts/licenses');
const sourceRepo = 'joeseesun/qiaomu-cover-fonts';
const ref = '1.0.0';
if (catalog.styles.length !== 20 || catalog.sourceTag !== ref) throw new Error('字体清单版本/数量不正确');
await mkdir(destination, { recursive: true });
await mkdir(licenseDir, { recursive: true });
const verifyOnly = process.argv.includes('--verify-only');
const skipDownload = process.argv.includes('--skip-download');
const baseUrls = [
  `https://raw.githubusercontent.com/${sourceRepo}/${ref}`,
  `https://cdn.jsdelivr.net/gh/${sourceRepo}@${ref}`
];
function digest(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function readValid(path, meta) {
  try {
    const buffer = await readFile(path);
    return buffer.byteLength === meta.bytes && digest(buffer) === meta.sha256;
  } catch { return false; }
}
async function downloadWithRetry(pathPart, expected) {
  let lastError;
  for (const urlBase of baseUrls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 100000);
        let response;
        try { response = await fetch(`${urlBase}/${pathPart}`, { signal: controller.signal }); }
        finally { clearTimeout(id); }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (expected && (bytes.length !== expected.bytes || digest(bytes) !== expected.sha256)) {
          throw new Error('文件大小或 SHA-256 不符，拒绝使用');
        }
        return bytes;
      } catch (error) { lastError = error; }
    }
  }
  throw new Error(`无法获取 ${pathPart}：${lastError?.message || lastError}`);
}
async function installFont(meta) {
  if (!/^[a-z0-9-]+$/.test(meta.id) || !/^[a-z0-9-]+\.(?:woff2|ttf)$/.test(meta.file)) {
    throw new Error('字体名称无效');
  }
  const path = join(destination, meta.file);
  if (!await readValid(path, meta)) {
    if (verifyOnly || skipDownload) throw new Error(`字体未就绪：${meta.file}`);
    const buffer = await downloadWithRetry(`fonts/${meta.file}`, meta);
    const temporary = path + '.tmp-' + process.pid;
    try { await writeFile(temporary, buffer); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  const licensePath = join(licenseDir, meta.id + '.txt');
  let validLicense = false;
  try {
    const text = await readFile(licensePath, 'utf8');
    validLicense = /SIL OPEN FONT LICENSE|Open Font License/i.test(text);
  } catch { /* License will be downloaded below. */ }
  if (!validLicense) {
    if (verifyOnly || skipDownload) throw new Error(`缺少字体授权：${meta.id}`);
    const buffer = await downloadWithRetry(`licenses/${meta.id}.txt`);
    const text = buffer.toString('utf8');
    if (!/SIL OPEN FONT LICENSE|Open Font License/i.test(text)) throw new Error(`授权文件无效：${meta.id}`);
    await writeFile(licensePath, text);
  }
  return meta.bytes;
}
let next = 0, successful = 0, totalBytes = 0;
const failures = [];
async function worker() {
  while (next < catalog.styles.length) {
    const meta = catalog.styles[next++];
    try {
      totalBytes += await installFont(meta);
      successful++;
      process.stdout.write(`[fonts] ${successful}/20 ${meta.name}\n`);
    } catch (error) { failures.push(error.message); }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
if (failures.length) {
  failures.forEach(error => console.error('[fonts]', error));
  throw new Error(`字体下载/验证失败 ${failures.length} 项，已停止发布构建。`);
}
console.log(`20 款字体及授权齐备（约 ${(totalBytes/1048576).toFixed(1)} MiB），可离线使用。`);
