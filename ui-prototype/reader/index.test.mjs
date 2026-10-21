import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReaderDocument } from './index.js';

test('reader adapter returns the shared chapter/block model for TXT', async () => {
  const file = new File(['第一章 开始\n第一段。\n\n第二章 继续\n第二段。'], 'novel.txt');
  const document = await parseReaderDocument(file, 'txt');
  assert.deepEqual(document.chapters.map(chapter => chapter.title), ['第一章 开始', '第二章 继续']);
  assert.equal(document.chapters[0].blocks[0].type, 'paragraph');
  assert.equal(document.chapters[0].blocks[0].value, '第一段。');
  assert.deepEqual(document.objectUrls, []);
});

test('TXT adapter accepts a selected legacy encoding and a custom heading pattern', async () => {
  const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, ...new TextEncoder().encode('Opening')]);
  const file = new File([bytes], 'novel.txt');
  const document = await parseReaderDocument(file, 'txt', { encoding: 'gb18030', pattern: '^第一章$' });
  assert.equal(document.chapters[0].title, '第一章');
  assert.equal(document.chapters[0].blocks[0].value, 'Opening');
});
