import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64Bytes } from './android-files.js';

test('decode native document bytes including non-ASCII payload', () => {
  const bytes = decodeBase64Bytes('AP/+AQ==');
  assert.deepEqual([...bytes], [0,255,254,1]);
});
