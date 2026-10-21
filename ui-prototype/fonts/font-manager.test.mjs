import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_FONTS } from './catalog.js';
import { isSupportedFont, safeFontId, fontOptionLabel, formatFontSize } from './font-manager.js';

test('font bundle exposes 20 unique styles, most covering Chinese', () => {
  assert.equal(BUILTIN_FONTS.length, 20);
  assert.equal(new Set(BUILTIN_FONTS.map(f => f.id)).size, 20);
  assert.ok(BUILTIN_FONTS.filter(f => f.cjk).length >= 18);
  for (const font of BUILTIN_FONTS) assert.ok(font.file.endsWith('.woff2') || font.file.endsWith('.ttf'));
});
test('font import validates magic bytes as well as extension', () => {
  const bytes = text => new TextEncoder().encode(text).buffer;
  assert.equal(isSupportedFont('test.otf', bytes('OTTO')), true);
  assert.equal(isSupportedFont('test.ttf', Uint8Array.from([0,1,0,0]).buffer), true);
  assert.equal(isSupportedFont('test.woff', bytes('wOFF')), true);
  assert.equal(isSupportedFont('test.woff2', bytes('wOF2')), true);
  assert.equal(isSupportedFont('not-a-font.ttf', bytes('ABCD')), false);
  assert.equal(isSupportedFont('script.js', bytes('wOF2')), false);
});
test('font id is sanitized and labels communicate limited glyph coverage', () => {
  assert.equal(safeFontId('built:wenkai'), 'built:wenkai');
  assert.equal(safeFontId('url(javascript:alert(1))'), 'system');
  assert.match(fontOptionLabel({name:'宋体',coverage:6000}),/回退/);
  assert.equal(formatFontSize(1048576 * 2), '2.0 MB');
});
