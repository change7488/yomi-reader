import test from 'node:test';
import assert from 'node:assert/strict';
import { tapRegion, pageDirectionForKey } from './reading-interactions.js';

test('reading surface divides into left, center and right actions', () => {
  assert.equal(tapRegion(10, 100), 'previous');
  assert.equal(tapRegion(50, 100), 'center');
  assert.equal(tapRegion(90, 100), 'next');
  assert.equal(tapRegion(-5, 100), 'previous');
});

test('keyboard supports arrows, paging and reversible space', () => {
  for (const key of ['ArrowLeft','ArrowUp','PageUp']) assert.equal(pageDirectionForKey(key), -1);
  for (const key of ['ArrowRight','ArrowDown','PageDown']) assert.equal(pageDirectionForKey(key), 1);
  assert.equal(pageDirectionForKey(' '), 1);
  assert.equal(pageDirectionForKey(' ', true), -1);
  assert.equal(pageDirectionForKey('Escape'), 0);
});
