// Android Storage Access Framework adapter: the only platform-specific import entrypoint.
// Files are read only after the user explicitly selects a file or directory.
import { isAndroidApp } from './mobile-shell.js';

export function androidFilePicker() {
  if (!isAndroidApp()) return null;
  return window.Capacitor?.Plugins?.ReaderFiles || null;
}
export async function chooseAndroidFolder() {
  const plugin = androidFilePicker();
  if (!plugin) throw new Error('当前 Android 版本缺少原生文件夹访问功能，请安装新版 APK');
  return plugin.chooseFolder();
}
export async function scanAndroidFolder(formats, minBytes = 0) {
  const plugin = androidFilePicker();
  if (!plugin) throw new Error('当前 Android 版本缺少原生文件夹扫描功能');
  const result = await plugin.scanFolder({
    extensions: formats.join(','),
    minBytes: Math.max(0, Math.floor(minBytes))
  });
  return {
    files: Array.isArray(result?.files) ? result.files : [],
    limited: Boolean(result?.limited),
    visited: Number(result?.visited) || 0,
    unreadableFolders: Number(result?.unreadableFolders) || 0
  };
}
export async function chooseAndroidFiles() {
  const plugin = androidFilePicker();
  if (!plugin) throw new Error('当前 Android 版本缺少多文件选择功能');
  const result = await plugin.chooseFiles();
  return result?.cancelled ? [] : result?.files || [];
}
export async function chooseAndroidFonts() {
  const plugin = androidFilePicker();
  if (!plugin?.chooseFonts) throw new Error('当前 Android 版本不支持导入字体文件');
  const result = await plugin.chooseFonts();
  if (result?.cancelled) return [];
  const files = [];
  for (const entry of result?.files || []) {
    files.push(await loadAndroidBook(entry));
  }
  return files;
}
export function decodeBase64Bytes(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
// A document's bytes cross the Capacitor bridge in 128KB chunks, not as one
// enormous Base64 response. Every session is closed, including failed imports.
export async function loadAndroidBook(entry) {
  const plugin = androidFilePicker();
  if (!plugin?.openRead || !plugin?.readChunk || !plugin?.closeRead || !entry?.key) {
    throw new Error('此版本不支持安全分块导入，请更新到最新版 APK');
  }
  const opened = await plugin.openRead({ key: entry.key });
  const handle = opened?.handle;
  if (!handle) throw new Error('无法获得文件读取权限');
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const next = await plugin.readChunk({ handle });
      if (next?.done) break;
      if (!next?.base64) throw new Error('文件读取中断，请重新选择该文件');
      const bytes = decodeBase64Bytes(next.base64);
      total += bytes.byteLength;
      if (total > 64 * 1024 * 1024) throw new Error('单个书籍超过 64MB 安全读取上限');
      parts.push(bytes);
    }
    if (!parts.length) throw new Error('该文件为空');
    return new File(parts, entry.name, { type: 'application/octet-stream' });
  } finally {
    await plugin.closeRead({ handle }).catch(error => console.warn('关闭 Android 文件流失败', error));
  }
}
