import test from 'node:test';
import assert from 'node:assert/strict';
import { openZipFile, resolveBookPath } from './archive.js';

function storedZip(path, text) {
  const encoder = new TextEncoder(), name = encoder.encode(path), data = encoder.encode(text);
  const localSize = 30 + name.length + data.length, centralSize = 46 + name.length;
  const bytes = new Uint8Array(localSize + centralSize + 22), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(8, 0, true);
  view.setUint32(18, data.length, true); view.setUint32(22, data.length, true); view.setUint16(26, name.length, true);
  bytes.set(name, 30); bytes.set(data, 30 + name.length);
  const central = localSize;
  view.setUint32(central, 0x02014b50, true); view.setUint16(central + 4, 20, true); view.setUint16(central + 6, 20, true);
  view.setUint32(central + 20, data.length, true); view.setUint32(central + 24, data.length, true); view.setUint16(central + 28, name.length, true);
  view.setUint32(central + 42, 0, true); bytes.set(name, central + 46);
  const end = central + centralSize;
  view.setUint32(end, 0x06054b50, true); view.setUint16(end + 8, 1, true); view.setUint16(end + 10, 1, true);
  view.setUint32(end + 12, centralSize, true); view.setUint32(end + 16, central, true);
  return new Blob([bytes]);
}

test('reads stored ZIP entries used by EPUB packages', async () => {
  const archive = await openZipFile(storedZip('OPS/chapter.xhtml', '<p>内容</p>'));
  assert.equal(new TextDecoder().decode(await archive.read('OPS/chapter.xhtml')), '<p>内容</p>');
});

test('resolves EPUB-relative paths and removes fragments', () => {
  assert.equal(resolveBookPath('OPS/Text/', '../Images/cover%20a.jpg#page=1'), 'OPS/Images/cover a.jpg');
});
