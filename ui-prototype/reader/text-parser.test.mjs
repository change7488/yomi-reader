import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTextChapters } from './text-parser.js';

test('recognizes Chinese light-novel chapter headings and separates paragraphs', () => {
  const chapters = parseTextChapters('序章\n开场。\n\n第一章 初遇\n第一段。\n第二段。\n\n第二章 再会\n结尾。');
  assert.deepEqual(chapters.map(chapter => chapter.title), ['序章', '第一章 初遇', '第二章 再会']);
  assert.deepEqual(chapters[1].blocks.map(block => block.value), ['第一段。', '第二段。']);
});

test('recognizes Japanese and English chapter headings', () => {
  assert.equal(parseTextChapters('第1話 始まり\n本文')[0].title, '第1話 始まり');
  assert.equal(parseTextChapters('Chapter 2: The Journey\nText')[0].title, 'Chapter 2: The Journey');
});

test('falls back to one readable chapter and supports a custom pattern', () => {
  const plain = parseTextChapters('无标题正文\n下一行');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].title, '正文');
  assert.equal(plain[0].blocks.length, 2);
  assert.deepEqual(parseTextChapters('Scene A\nOne\nScene B\nTwo', '^Scene\\s+[A-Z]$').map(chapter => chapter.title), ['Scene A', 'Scene B']);
});

test('keeps decoded source character offsets for stable TXT position anchors', () => {
  const text = '\uFEFF序章\r\n开场段落\r\n\r\n第一章\r\n第一段正文\r\n第二段正文';
  const chapters = parseTextChapters(text);
  const firstParagraph = chapters[1].blocks[0];
  assert.equal(firstParagraph.value, '第一段正文');
  assert.equal(firstParagraph.sourceOffset, text.indexOf('第一段正文'));
});

test('reports malformed custom chapter rules instead of silently using defaults', () => {
  assert.throws(() => parseTextChapters('正文', '['), SyntaxError);
});
