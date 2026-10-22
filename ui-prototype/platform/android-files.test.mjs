import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase64Bytes, loadAndroidBook, scanAndroidFolder } from './android-files.js';

test('decode native document bytes including non-ASCII payload', () => {
  const bytes = decodeBase64Bytes('AP/+AQ==');
  assert.deepEqual([...bytes], [0,255,254,1]);
});

test('Android file reading consumes small chunks and always closes the native stream', async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  const chunks = [Buffer.from([0,1,255]), Buffer.from([4,5,6])];
  let chunkIndex = 0;
  globalThis.window = { Capacitor: {
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: { ReaderFiles: {
      openRead: async ({key}) => { calls.push('open:' + key); return {handle:'session-1'}; },
      readChunk: async ({handle}) => {
        calls.push('chunk:' + handle);
        return chunkIndex >= chunks.length ? {done:true,base64:''} :
          {done:false,base64:chunks[chunkIndex++].toString('base64')};
      },
      closeRead: async ({handle}) => { calls.push('close:' + handle); }
    }}
  }};
  try {
    const file = await loadAndroidBook({key:'book-key',name:'小说.epub'});
    assert.equal(file.name,'小说.epub');
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())],[0,1,255,4,5,6]);
    assert.equal(calls.at(-1),'close:session-1');
    assert.equal(calls.filter(x=>x.startsWith('chunk:')).length,3);
  } finally { globalThis.window = previousWindow; }
});

test('Android streaming closes the native stream even when a chunk fails', async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = { Capacitor: {
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: { ReaderFiles: {
      openRead: async () => ({handle:'s'}),
      readChunk: async () => { throw new Error('读取出错'); },
      closeRead: async () => { calls.push('closed'); }
    }}
  }};
  try {
    await assert.rejects(loadAndroidBook({key:'a',name:'x.txt'}),/读取出错/);
    assert.deepEqual(calls,['closed']);
  } finally { globalThis.window = previousWindow; }
});

test('Android folder scan retains truncation and unavailable-directory warnings', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { Capacitor: {
    isNativePlatform: () => true, getPlatform: () => 'android',
    Plugins: { ReaderFiles: {scanFolder: async () => ({
      files:[{name:'a.epub',key:'x'}],limited:true,visited:20000,unreadableFolders:3
    })} }
  }};
  try {
    const result = await scanAndroidFolder(['epub'],0);
    assert.equal(result.files.length,1);
    assert.equal(result.limited,true);
    assert.equal(result.unreadableFolders,3);
  } finally { globalThis.window = previousWindow; }
});
