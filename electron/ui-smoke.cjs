const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomi-ui-smoke-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  try {
    await win.loadFile(path.join(__dirname, '../ui-prototype/index.html'));
    await win.webContents.executeJavaScript(`new Promise(resolve => { const check = () => document.querySelector('#dashboardStats')?.children.length ? resolve() : setTimeout(check, 40); check(); })`);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const $ = id => document.getElementById(id);
      const click = selector => document.querySelector(selector).click();
      const checks = {};
      checks.home = !$('dashboard').classList.contains('hidden') && $('dashboardStats').children.length === 4;
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
      await new Promise((resolve,reject) => { const started=Date.now(); const check=() => { if ($('readerStage').textContent.includes('这是第一段')) resolve(); else if (Date.now()-started>5000) reject(new Error('打开 TXT 超时')); else setTimeout(check,40); }; check(); });
      checks.reader = !$('readerModal').classList.contains('hidden') && $('readerStage').textContent.includes('这是第一段');
      $('readerBack').click();
      await new Promise((resolve,reject) => { const started=Date.now(); const check=() => { if ($('readerModal').classList.contains('hidden')) resolve(); else if (Date.now()-started>5000) reject(new Error('关闭阅读页超时')); else setTimeout(check,40); }; check(); });
      checks.readerClose = $('readerModal').classList.contains('hidden');
      return checks;
    })()`);
    console.log(JSON.stringify(result));
    if (Object.values(result).some(value => !value)) throw new Error('界面冒烟测试未通过');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); app.exit(process.exitCode || 0); }
});
app.on('window-all-closed', () => {});
