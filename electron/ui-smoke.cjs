const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([{ scheme:'libra', privileges:{ standard:true, secure:true, supportFetchAPI:true, corsEnabled:true } }]);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-ui-smoke-'));
const readerPreload = path.join(profile, 'reader-test-preload.cjs');
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const webRoot = path.resolve(__dirname, '../ui-prototype');
  protocol.handle('libra', request => {
    const relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(webRoot, relative);
    if (file !== webRoot && !file.startsWith(`${webRoot}${path.sep}`)) return new Response('Not found', {status:404});
    return net.fetch(pathToFileURL(file).href);
  });
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') console.error('[Renderer]', event.message);
  });
  try {
    await win.loadURL('libra://app/index.html');
    await win.webContents.executeJavaScript(`new Promise(resolve => { const check = () => document.querySelector('#dashboardStats')?.children.length ? resolve() : setTimeout(check, 40); check(); })`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id);
      const click = selector => document.querySelector(selector).click();
      const checks = {};
      checks.home = !$('dashboard').classList.contains('hidden') && $('dashboardStats').children.length === 4;
      checks.originalBrand = document.querySelector('.brand-mark img')?.getAttribute('src') === 'assets/yomi-reader.png' &&
        document.querySelector('.brand-mark img')?.complete && document.querySelector('.brand-mark img')?.naturalWidth > 0;
      checks.onboardingWelcome = !!document.querySelector('#yomiWelcomeTitle');
      document.querySelector('[data-guide-skip]')?.click();
      checks.onboardingSkip = !document.querySelector('.yomi-guide-layer') && !!JSON.parse(localStorage.getItem('yomi-onboarding-v1'))?.completed;
      checks.styles = getComputedStyle(document.querySelector('.sidebar')).position === 'fixed';
      click('[data-view="all"]');
      checks.library = !$('libraryView').classList.contains('hidden') && $('bookGrid').children.length > 0;
      click('.view-toggle:nth-of-type(2)');
      checks.list = $('bookGrid').classList.contains('list-mode');
      click('.view-toggle:first-of-type');
      checks.grid = !$('bookGrid').classList.contains('list-mode');
      $('coverDensityRange').value = '240';
      $('coverDensityRange').dispatchEvent(new Event('input', { bubbles:true }));
      $('coverDensityRange').dispatchEvent(new Event('change', { bubbles:true }));
      checks.density = document.body.style.getPropertyValue('--cover-width') === '240px' && localStorage.getItem('yomi-cover-width') === '240';
      $('themeBtn').click();
      checks.themePanel = !$('appearancePopover').classList.contains('hidden');
      click('[data-palette-choice="lilac"]');
      click('[data-mode-choice="dark"]');
      checks.theme = document.body.dataset.palette === 'lilac' && !document.body.classList.contains('light-mode');
      click('[data-palette-choice="mint"]');
      click('[data-mode-choice="light"]');
      click('#folderCreateNavBtn');
      checks.folder = !$('folderEditorModal').classList.contains('hidden');
      click('#folderEditorCancel');
      checks.folderCancel = $('folderEditorModal').classList.contains('hidden');
      click('#settingsBtn');
      checks.settings = !$('settingsPage').classList.contains('hidden');
      checks.offlineFontCatalog = $('settingsPage').querySelectorAll('.yomi-font-card').length === 21;
      checks.fontImportControl = !!$('settingsPage').querySelector('[data-font-import]');
      checks.helpEntry = !!$('yomiSettingsHelp') && !!$('yomiReplayGuide');
      $('yomiSettingsHelp').click();
      checks.helpOpens = !!document.querySelector('#yomiHelpTitle');
      document.querySelector('[data-guide-close]')?.click();
      checks.readerControls = !!$('readerModal') && !!$('readerTocToggle') && !!$('readerSettingsToggle');
      const sample = new File(['第一章 初见\\n\\n这是第一段。\\n\\n这是第二段。'], '界面测试.txt', { type:'text/plain' });
      const transfer = new DataTransfer(); transfer.items.add(sample);
      $('fileInput').files = transfer.files;
      $('fileInput').dispatchEvent(new Event('change', { bubbles:true }));
      await new Promise((resolve,reject) => { const started=Date.now(); const check=() => { if ($('bookGrid').querySelector('[data-open]:not([data-open^="demo"])') && $('resultText').textContent.includes('共 1 本')) resolve(); else if (Date.now()-started>5000) reject(new Error('导入 TXT 超时')); else setTimeout(check,40); }; check(); });
      checks.import = $('resultText').textContent.includes('共 1 本');
      const realBook = [...$('bookGrid').querySelectorAll('[data-open]')].find(button => button.getAttribute('aria-label')?.includes('界面测试'));
      realBook.click();
      await new Promise((resolve,reject) => { const started=Date.now(); const check=() => { if ($('readerStage').textContent.includes('这是第一段')) resolve(); else if (Date.now()-started>5000) reject(new Error('打开 TXT 超时：' + $('readerStage').textContent.slice(0,280) + '，打开状态=' + !$('readerModal').classList.contains('hidden') + '，书目连接=' + realBook.isConnected + '，消息=' + $('toastStack').textContent.slice(0,260))); else setTimeout(check,40); }; check(); });
      checks.reader = !$('readerModal').classList.contains('hidden') && $('readerStage').textContent.includes('这是第一段');
      checks.readerFontPanel = $('readerSettings').querySelectorAll('.yomi-font-card').length === 21;
      $('readerBack').click();
      await new Promise((resolve,reject) => { const started=Date.now(); const check=() => { if ($('readerModal').classList.contains('hidden')) resolve(); else if (Date.now()-started>5000) reject(new Error('关闭阅读页超时')); else setTimeout(check,40); }; check(); });
      checks.readerClose = $('readerModal').classList.contains('hidden');

      // Exercise the shared PDF.js path on desktop using a tiny generated PDF.
      const pdfObjects = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\\n',
        '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\\n',
        '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 420] /Resources << >> /Contents 4 0 R >> endobj\\n',
        '4 0 obj << /Length 0 >> stream\\n\\nendstream endobj\\n'
      ];
      let pdfText = '%PDF-1.4\\n'; const offsets = [0];
      for (const object of pdfObjects) { offsets.push(new TextEncoder().encode(pdfText).length); pdfText += object; }
      const xrefOffset = new TextEncoder().encode(pdfText).length;
      pdfText += 'xref\\n0 ' + offsets.length + '\\n0000000000 65535 f \\n' + offsets.slice(1).map(offset => String(offset).padStart(10,'0') + ' 00000 n \\n').join('') + 'trailer << /Size ' + offsets.length + ' /Root 1 0 R >>\\nstartxref\\n' + xrefOffset + '\\n%%EOF';
      const pdfFile = new File([pdfText], '漫画模式测试.pdf', {type:'application/pdf'});
      const pdfTransfer = new DataTransfer(); pdfTransfer.items.add(pdfFile); $('fileInput').files = pdfTransfer.files; $('fileInput').dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise((resolve,reject) => { const start=Date.now(); const check=()=>{const card=[...$('bookGrid').querySelectorAll('[data-open]')].find(item=>item.getAttribute('aria-label')?.includes('漫画模式测试')); if(card)resolve();else if(Date.now()-start>5000)reject(new Error('导入 PDF 超时'));else setTimeout(check,40)};check(); });
      const pdfCard = [...$('bookGrid').querySelectorAll('[data-open]')].find(item=>item.getAttribute('aria-label')?.includes('漫画模式测试')); pdfCard.click();
      await new Promise((resolve,reject) => { const start=Date.now(); const check=()=>{if($('readerStage').querySelector('.yomi-pdf-page canvas'))resolve();else if(Date.now()-start>10000)reject(new Error('PDF.js 页面渲染超时：'+$('readerStage').textContent.slice(0,180)));else setTimeout(check,50)};check(); });
      checks.sharedPdfRenderer = !$('readerPdfControls').classList.contains('hidden') && $('readerPdfPageCount').textContent === '1';
      $('pdfModeSelect').value = 'double'; $('pdfModeSelect').dispatchEvent(new Event('change',{bubbles:true}));
      checks.comicModeControls = $('pdfComicTools').querySelectorAll('select').length >= 5 && !!$('readerStage').querySelector('.yomi-pdf-spread');
      $('pdfDirectionSelect').value = 'ttb'; $('pdfDirectionSelect').dispatchEvent(new Event('change',{bubbles:true}));
      checks.verticalDirectionUsesScroll = $('pdfModeSelect').value === 'scroll' && $('readerStage').classList.contains('yomi-pdf-continuous');
      $('readerBack').click();
      await new Promise(resolve => setTimeout(resolve,100));

      // Regression: previewing a large directory must not create hundreds of row nodes.
      $('dashboardImportFolderBtn').click();
      const manyFiles = new DataTransfer();
      for (let i = 0; i < 180; i++) {
        const file = new File(['sample'], 'novel-' + i + '.epub', {type:'application/epub+zip'});
        Object.defineProperty(file, 'webkitRelativePath', { value: 'ExampleFolder/novel-' + i + '.epub' });
        manyFiles.items.add(file);
      }
      $('folderInput').files = manyFiles.files;
      $('folderInput').dispatchEvent(new Event('change', { bubbles:true }));
      await new Promise((resolve,reject) => {
        const begin=Date.now();
        const tick=() => {
          if ($('folderScanSummary').textContent.includes('180') && $('folderFileList').querySelectorAll('.folder-file-row').length === 60) resolve();
          else if (Date.now()-begin>5000) reject(new Error('文件夹扫描预览超时：'+$('folderScanSummary').textContent));
          else setTimeout(tick,40);
        }; tick();
      });
      checks.folderPreviewBounded = $('folderFileList').querySelectorAll('.folder-file-row').length === 60;
      $('folderFileList').querySelector('[data-folder-show-more]').click();
      checks.folderShowMore = $('folderFileList').querySelectorAll('.folder-file-row').length === 120;
      $('folderSelectAll').checked = false;
      $('folderSelectAll').dispatchEvent(new Event('change', { bubbles: true }));
      checks.folderUnselectAll = $('folderImportStart').disabled;
      $('folderSelectAll').checked = true;
      $('folderSelectAll').dispatchEvent(new Event('change', { bubbles: true }));
      checks.folderBatchLimit = $('folderImportStart').textContent.includes('50') && $('folderImportStart').textContent.includes('130');
      $('folderImportClose').click();
      return checks;
    })()`);
    fs.writeFileSync(readerPreload, `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('libraDesktop', {
  isDesktop:true, readerReady:async()=>true, focusLibrary:async()=>true, confirmReaderClose:async()=>true,
  onOpenBook:callback=>{ipcRenderer.on('desktop-open-book',(_event,id)=>callback(id));return()=>{};},
  onReaderCloseRequest:callback=>{ipcRenderer.on('desktop-reader-close-request',(_event,value)=>callback(value));return()=>{};},
  onBookFile:()=>()=>{}, onDownload:()=>()=>{}, getDownloadFolder:async()=>'', getLibraryFolder:async()=>'',
  openOnline:async()=>true, chooseDownloadFolder:async()=>null, readBookFile:async()=>null, chooseImportFolder:async()=>null,
  scanImportFolder:async()=>[], readImportFile:async()=>null, chooseLibraryFolder:async()=>null, setLibraryFolder:async()=>null,
  copyBookFromPath:async()=>null, copyBookBytes:async()=>null, readLibraryBook:async()=>null, stageLibraryBook:async()=>null,
  restoreLibraryBook:async()=>null, trashStagedBook:async()=>null, getPathForFile:()=>''
});`);
    const bookId = await win.webContents.executeJavaScript(`document.querySelector('#bookGrid [data-open][aria-label*="界面测试"]')?.dataset.open`);
    const readerWindow = new BrowserWindow({ show:false, width:1200, height:800, webPreferences:{ preload:readerPreload, contextIsolation:true, nodeIntegration:false } });
    const readerConsole = [];
    readerWindow.webContents.on('console-message', event => { if (event.level >= 2) { readerConsole.push(event.message); console.error('[Reader renderer]', event.message); } });
    await readerWindow.loadURL(`libra://app/index.html?${new URLSearchParams({window:'reader',bookId})}`);
    await readerWindow.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(document.querySelector('#readerTabs [data-reader-tab]') && document.querySelector('#readerStage').textContent.includes('这是第一段')) resolve();else if(Date.now()-start>8000)reject(new Error('独立阅读窗口启动超时：标签='+document.querySelector('#readerTabs')?.textContent+'；正文='+document.querySelector('#readerStage')?.textContent.slice(0,240)+'；提示='+document.querySelector('#toastStack')?.textContent));else setTimeout(check,40)};check()})`);
    const readerWindowChecks = await readerWindow.webContents.executeJavaScript(`({readerMode:document.body.classList.contains('desktop-reader-window'), shellHidden:getComputedStyle(document.querySelector('.app-shell')).display==='none', oneTab:document.querySelectorAll('#readerTabs [data-reader-tab]').length===1, content:document.querySelector('#readerStage').textContent.includes('这是第一段')})`);
    Object.assign(result, { readerWindowMode:readerWindowChecks.readerMode, readerWindowShellHidden:readerWindowChecks.shellHidden, readerWindowTab:readerWindowChecks.oneTab, readerWindowContent:readerWindowChecks.content });
    readerWindow.destroy();
    console.log(JSON.stringify(result));
    if (readerConsole.length) console.error('[Reader console summary]', readerConsole.join(' | '));
    if (Object.values(result).some(value => !value)) throw new Error('界面冒烟测试未通过');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
app.on('window-all-closed', () => {});
