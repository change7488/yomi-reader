const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'screenshots');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-readme-shot-'));
app.setPath('userData', profile);

function waitFor(win, pageExpression, timeout = 10000) {
  return win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{try{if(${pageExpression})return resolve(true)}catch{}if(Date.now()-start>${timeout})return reject(new Error('Screenshot setup timed out'));setTimeout(poll,50)};poll()})`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  try {
    await win.loadFile(path.join(projectRoot, 'ui-prototype/index.html'));
    await waitFor(win, "document.querySelector('#dashboardStats')?.children.length === 4");
    await win.webContents.executeJavaScript(`(async()=>{
      const file=new File(['第一章 月光下的约定\\n\\n晚风穿过校园的樱花树。\\n\\n她把书签夹回书页，抬头望向亮起灯光的图书馆。\\n\\n“明天见。”\\n\\n第二章 新的旅程\\n\\n清晨的车站传来列车进站的声音。'],'星海物语.txt',{type:'text/plain'});
      const transfer=new DataTransfer();transfer.items.add(file);const input=document.getElementById('fileInput');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(document.getElementById('resultText').textContent.includes('共 1 本'))return resolve();if(Date.now()-start>8000)return reject(new Error('Demo book import timed out'));setTimeout(poll,50)};poll()});
      const request=indexedDB.open('libra-reader-preview');const db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
      const tx=db.transaction('books','readwrite'),store=tx.objectStore('books'),all=await new Promise((resolve,reject)=>{const r=store.getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
      const book=all[0];book.progress=37;book.lastRead=Date.now();book.lastChapterTitle='第一章 · 月光下的约定';store.put(book);await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error)});db.close();
    })()`);
    await win.webContents.reload();
    await waitFor(win, "document.querySelector('#dashboardStats')?.children.length === 4 && document.querySelector('#continueCard')?.textContent.includes('星海物语')");
    await new Promise(resolve => setTimeout(resolve, 500));
    await win.webContents.executeJavaScript(`document.head.insertAdjacentHTML('beforeend','<style>*{animation:none!important;transition:none!important}</style>');Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))`);
    await fsp.mkdir(outputDir, { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'home.png'), await win.webContents.capturePage().then(image => image.toPNG()));
    await win.webContents.executeJavaScript(`document.querySelector('[data-view="all"]').click()`);
    await waitFor(win, "!document.querySelector('#libraryView').classList.contains('hidden')");
    await win.webContents.executeJavaScript(`Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))`);
    await fsp.writeFile(path.join(outputDir, 'library.png'), await win.webContents.capturePage().then(image => image.toPNG()));
    console.log('Saved screenshots/home.png and screenshots/library.png');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
