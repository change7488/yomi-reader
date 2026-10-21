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
  return result?.files || [];
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
export async function loadAndroidBook(entry) {
  const plugin = androidFilePicker();
  if (!plugin || !entry?.key) throw new Error('文件授权已失效，请重新选择');
  const result = await plugin.readFile({ key: entry.key });
  if (!result?.base64) throw new Error('读取失败，文件为空或权限已失效');
  const bytes = decodeBase64Bytes(result.base64);
  return new File([bytes], entry.name, { type: 'application/octet-stream' });
}
