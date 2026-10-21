/** Minimal ZIP reader for EPUB containers. Format code stays separate from UI. */
export async function openZipFile(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let p = Math.max(0, bytes.length - 65557); p <= bytes.length - 22; p++) {
    if (view.getUint32(p, true) === 0x06054b50) eocd = p;
  }
  if (eocd < 0) throw new Error('EPUB 压缩目录无效');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('EPUB 文件条目无效');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  async function read(path) {
    const entry = entries.get(path);
    if (!entry) throw new Error(`EPUB 缺少文件：${path}`);
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const part = bytes.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return part;
    if (entry.method !== 8 || !('DecompressionStream' in window)) throw new Error('当前浏览器无法解压 EPUB 内容');
    const stream = new Blob([part]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { entries, read };
}

export const dirname = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';

export function resolveBookPath(base, href = '') {
  const raw = decodeURIComponent(String(href).split(/[?#]/, 1)[0]);
  const parts = [];
  for (const piece of `${base}${raw}`.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}
