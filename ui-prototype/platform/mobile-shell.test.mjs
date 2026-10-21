import test from 'node:test';
import assert from 'node:assert/strict';
import { isAndroidApp, swipeDirection } from './mobile-shell.js';

test('mobile shell only activates in native Android', () => {
  assert.equal(isAndroidApp({ isNativePlatform: () => true, getPlatform: () => 'android' }), true);
  assert.equal(isAndroidApp({ isNativePlatform: () => false, getPlatform: () => 'android' }), false);
  assert.equal(isAndroidApp({ isNativePlatform: () => true, getPlatform: () => 'ios' }), false);
  assert.equal(isAndroidApp(undefined), false);
});

test('horizontal swipes flip pages and vertical scroll does not', () => {
  assert.equal(swipeDirection(-110, 12, 180), 1);
  assert.equal(swipeDirection(110, -2, 150), -1);
  assert.equal(swipeDirection(20, 130, 230), 0);
  assert.equal(swipeDirection(-120, 80, 150), 1);
  assert.equal(swipeDirection(-120, 80, 1100), 0);
});
