import test from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_PAGE_SIZE, visibleImportItems, planImportBatch, ANDROID_MAX_FILES_PER_BATCH } from './folder-import-policy.js';

test('folder preview is bounded even when thousands of matching files exist', () => {
  const items = Array.from({ length: 10000 }, (_, i) => ({ name: i, selected: true }));
  assert.equal(visibleImportItems(items).length, PREVIEW_PAGE_SIZE);
  assert.equal(visibleImportItems(items, 180).length, 180);
  assert.equal(visibleImportItems(items, 0).length, 0);
});

test('Android bulk imports are capped by count and approximate file size', () => {
  const files = Array.from({ length: 1000 }, (_, i) => ({ id: i, size: 3 * 1024 * 1024, selected: true }));
  const first = planImportBatch(files, true);
  assert.equal(first.batch.length, ANDROID_MAX_FILES_PER_BATCH);
  assert.equal(first.remaining, 1000 - ANDROID_MAX_FILES_PER_BATCH);
  first.batch.forEach(item => { item.selected = false; });
  const next = planImportBatch(files, true);
  assert.equal(next.batch[0].id, ANDROID_MAX_FILES_PER_BATCH);
  assert.equal(next.totalSelected, 1000 - ANDROID_MAX_FILES_PER_BATCH);
});
test('size budget prevents large batches and unselected books remain excluded', () => {
  const a = Array.from({ length: 5 }, (_, i) => ({ id: i, size: 40 * 1024 * 1024, selected: i !== 3 }));
  const plan = planImportBatch(a, true);
  assert.equal(plan.batch.length, 2);
  assert.equal(plan.remaining, 2);
  assert.deepEqual(plan.batch.map(x => x.id), [0, 1]);
});
test('Windows count budget is larger than Android while still bounded', () => {
  const files = Array.from({ length: 4000 }, (_, i) => ({ id: i, size: 100, selected: true }));
  const plan = planImportBatch(files, false);
  assert.equal(plan.batch.length, 50);
  assert.equal(plan.remaining, 3950);
});
