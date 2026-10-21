import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoLaunch, guideStepsForFormat } from './onboarding.js';

test('fresh installation shows the onboarding welcome', () => {
  assert.equal(shouldAutoLaunch({ booksCount: 0, tasksCount: 0 }), true);
});

test('existing users do not get forced into onboarding', () => {
  assert.equal(shouldAutoLaunch({ booksCount: 3 }), false);
  assert.equal(shouldAutoLaunch({ tasksCount: 1 }), false);
  assert.equal(shouldAutoLaunch({ hasLegacyPreferences: true }), false);
  assert.equal(shouldAutoLaunch({ storedState: { version: 1, completed: true } }), false);
  assert.equal(shouldAutoLaunch({ storedState: { version: 1, phase: 'reader-pending' } }), false);
});

test('PDF guide excludes unsupported EPUB/TXT-specific navigation', () => {
  assert.deepEqual(guideStepsForFormat('pdf'), ['pdf']);
  assert.deepEqual(guideStepsForFormat('PDF'), ['pdf']);
  assert.deepEqual(guideStepsForFormat('epub'), ['toc', 'settings', 'history']);
  assert.deepEqual(guideStepsForFormat('txt'), ['toc', 'settings', 'history']);
});
