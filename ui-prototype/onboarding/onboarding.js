const KEY = 'yomi-onboarding-v1';
const VERSION = 1;
const LEGACY_KEYS = ['yomi-appearance', 'yomi-cover-width', 'libra-sidebar-collapsed', 'libra-theme'];
const HELP = {
  start: { title: '开始使用', html: '<p>在首页点击「导入图书」，选择 EPUB、TXT 或 PDF，也可以扫描整个文件夹。书籍会保存在本机书库中。</p><p>导入后点击封面即可阅读。你可以通过左侧「我的书库」整理书籍，用「阅读记录」继续之前的故事。</p>' },
  reading: { title: '阅读与排版', html: '<p>EPUB/TXT：鼠标滚轮或 PageUp / PageDown 翻页；点击「目录」跳转章节；用「排版」调整字体、行距、文本宽度及主题。</p><p>阅读器底部提供进度条、书签、搜索及位置历史。阅读位置会自动保存在本机。</p><p>PDF 暂时使用 Electron 内置预览器，和 EPUB/TXT 的排版、进度历史能力不同。</p>' },
  progress: { title: '找回阅读位置', html: '<p>EPUB/TXT 通过目录、书签和进度条跳转时，可以使用阅读器底部的「后退」按钮回到之前的位置，或打开「位置历史」查看最近跳转与阅读会话。</p><p>正常翻页不会每翻一页就新增一条跳转历史。PDF 当前不支持此精确位置恢复。</p>' },
  shortcuts: { title: '快捷键', html: '<p><kbd>Ctrl + K</kbd>：定位书库搜索框（Windows）。<br><kbd>PageUp</kbd> / <kbd>PageDown</kbd>：在 EPUB/TXT 阅读器里翻页。<br><kbd>F11</kbd>：切换阅读器全屏。<br><kbd>Ctrl + Shift + ←</kbd> / <kbd>→</kbd>：阅读位置后退 / 前进。<br><kbd>Esc</kbd>：退出帮助或关闭阅读器。</p>' }
};

export function shouldAutoLaunch({ storedState = null, booksCount = 0, tasksCount = 0, hasLegacyPreferences = false } = {}) {
  return !storedState && booksCount === 0 && tasksCount === 0 && !hasLegacyPreferences;
}
export function guideStepsForFormat(format) {
  return String(format).toLowerCase() === 'pdf' ? ['pdf'] : ['toc', 'settings', 'history'];
}
export function createOnboarding({ navigateHome, hasBooks, getReaderFormat } = {}) {
  let state = readState() || { version: VERSION, phase: 'new', completed: false };
  let layer = null, target = null, targetClick = null, onWindowMove = null;
  let lastFocus = null, readerIndex = 0, helpTab = 'start';
  function readState() {
    try { const raw = localStorage.getItem(KEY); const parsed = raw ? JSON.parse(raw) : null; return parsed && parsed.version === VERSION ? parsed : null; }
    catch (_) { return null; }
  }
  function persist(patch) {
    state = Object.assign({}, state, patch, { version: VERSION });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
  }
  function restoreFocus() {
    if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
  function clear() {
    if (target && targetClick) target.removeEventListener('click', targetClick, true);
    if (onWindowMove) { window.removeEventListener('resize', onWindowMove); window.removeEventListener('scroll', onWindowMove, true); }
    if (target) target.classList.remove('yomi-guide-anchor');
    target = null; targetClick = null; onWindowMove = null;
    if (layer) layer.remove();
    layer = null;
    restoreFocus();
  }
  function trapKeys(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...layer.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(el => el.getClientRects().length);
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0].focus(); }
  }
  function mount(className, html) {
    clear();
    lastFocus = document.activeElement;
    layer = document.createElement('div');
    layer.className = 'yomi-guide-layer ' + className;
    layer.innerHTML = html;
    layer.addEventListener('keydown', trapKeys);
    document.body.appendChild(layer);
    const first = layer.querySelector('button');
    if (first) first.focus({ preventScroll: true });
    return layer;
  }
  function dismiss() {
    persist({ phase: 'dismissed', completed: true });
    clear();
  }
  function complete() {
    persist({ phase: 'completed', completed: true });
    clear();
  }
  function welcome() {
    persist({ phase: 'welcome', completed: false });
    const root = mount('yomi-guide-modal', '<div class="yomi-guide-scrim"></div><section class="yomi-guide-welcome" role="dialog" aria-modal="true" aria-labelledby="yomiWelcomeTitle"><div class="yomi-guide-illustration" aria-hidden="true"><span>✦</span><div>📖</div><span>✧</span></div><p class="yomi-guide-kicker">YOUR READING SPACE</p><h2 id="yomiWelcomeTitle">欢迎来到 Yomi Reader</h2><p class="yomi-guide-lead">让每一段故事，都有自己的栖身之所。</p><p class="yomi-guide-description">用几步认识你的私人书库。可以随时跳过，以后在「偏好设置」中重新查看。</p><div class="yomi-guide-actions"><button class="yomi-guide-quiet" data-guide-skip>暂时跳过</button><button class="yomi-guide-primary" data-guide-next>开始体验 <span aria-hidden="true">→</span></button></div></section>');
    root.querySelector('[data-guide-skip]').onclick = dismiss;
    root.querySelector('[data-guide-next]').onclick = importGuide;
  }
  function spotlight(selector, spec) {
    const element = document.querySelector(selector);
    if (!element || element.disabled) { if (spec.onMissing) spec.onMissing(); else clear(); return; }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const root = mount('yomi-guide-spotlight', '<div class="yomi-guide-shades"><div></div><div></div><div></div><div></div></div><div class="yomi-guide-ring" aria-hidden="true"></div><section class="yomi-guide-tip" role="dialog" aria-modal="true" aria-labelledby="yomiGuideStepTitle"><div class="yomi-guide-step-tag">' + spec.tag + '</div><h2 id="yomiGuideStepTitle">' + spec.title + '</h2><p>' + spec.text + '</p><div class="yomi-guide-actions"><button class="yomi-guide-quiet" data-guide-skip>跳过教程</button><button class="yomi-guide-primary" data-guide-next>下一步 →</button></div></section>');
    target = element;
    target.classList.add('yomi-guide-anchor');
    const shades = [...root.querySelectorAll('.yomi-guide-shades > div')];
    const ring = root.querySelector('.yomi-guide-ring');
    const tip = root.querySelector('.yomi-guide-tip');
    function layout() {
      if (!layer || !target?.isConnected) return;
      const rect = target.getBoundingClientRect(), pad = 7, w = window.innerWidth, h = window.innerHeight;
      const x = Math.max(0, rect.left - pad), y = Math.max(0, rect.top - pad), r = Math.min(w, rect.right + pad), b = Math.min(h, rect.bottom + pad);
      const areas = [[0, 0, w, y], [0, y, x, b - y], [r, y, w - r, b - y], [0, b, w, h - b]];
      areas.forEach((a, i) => { Object.assign(shades[i].style, { left: a[0] + 'px', top: a[1] + 'px', width: Math.max(0, a[2]) + 'px', height: Math.max(0, a[3]) + 'px' }); });
      Object.assign(ring.style, { left: x + 'px', top: y + 'px', width: (r - x) + 'px', height: (b - y) + 'px' });
      const tipWidth = Math.min(340, w - 24), tipHeight = tip.offsetHeight || 205;
      const below = b + 16 + tipHeight <= h, desiredTop = below ? b + 16 : y - tipHeight - 16;
      Object.assign(tip.style, { left: Math.max(12, Math.min(w - tipWidth - 12, x)) + 'px', top: Math.max(12, Math.min(h - tipHeight - 12, desiredTop)) + 'px', width: tipWidth + 'px' });
    }
    targetClick = () => { if (!layer) return; clear(); spec.onClick?.(); };
    element.addEventListener('click', targetClick, true);
    onWindowMove = () => window.requestAnimationFrame(layout);
    window.addEventListener('resize', onWindowMove);
    window.addEventListener('scroll', onWindowMove, true);
    root.querySelector('[data-guide-skip]').onclick = dismiss;
    root.querySelector('[data-guide-next]').onclick = () => { clear(); spec.onNext?.(); };
    window.requestAnimationFrame(layout);
  }
  function importGuide() {
    navigateHome?.();
    persist({ phase: 'import', completed: false });
    window.requestAnimationFrame(() => spotlight('#dashboardImportBtn', {
      tag: '01 / 03 · 导入书籍', title: '从第一本书开始',
      text: '点击高亮的「导入图书」，选取电脑中的 EPUB、TXT 或 PDF 文件。也可以先点「下一步」，以后再导入。',
      onClick: waitForBook, onNext: waitForBook, onMissing: waitForBook
    }));
  }
  function waitForBook() {
    persist({ phase: 'waiting-book', completed: false });
    if (hasBooks?.()) bookGuide();
  }
  function bookGuide() {
    persist({ phase: 'open-book', completed: false });
    navigateHome?.();
    window.requestAnimationFrame(() => spotlight('#recentBooks [data-open]', {
      tag: '02 / 03 · 打开故事', title: '打开一本书，继续探索',
      text: '点击这本书的封面开始阅读。打开 EPUB 或 TXT 后，我会进一步介绍阅读操作。',
      onClick: () => persist({ phase: 'reader-pending' }),
      onNext: () => persist({ phase: 'reader-pending' }),
      onMissing: () => persist({ phase: 'reader-pending' })
    }));
  }
  function pdfGuide() {
    persist({ phase: 'pdf-info', completed: false });
    const root = mount('yomi-guide-modal', '<div class="yomi-guide-scrim"></div><section class="yomi-guide-welcome yomi-guide-compact" role="dialog" aria-modal="true" aria-labelledby="yomiPdfTitle"><p class="yomi-guide-kicker">03 / 03 · PDF 阅读</p><h2 id="yomiPdfTitle">PDF 使用系统预览模式</h2><p>可以查看 PDF 内容，但 EPUB/TXT 专属的重排版式、精确跳转历史和撤回暂不适用于 PDF。</p><div class="yomi-guide-actions"><button class="yomi-guide-primary" data-guide-complete>明白了，开始阅读</button></div></section>');
    root.querySelector('[data-guide-complete]').onclick = complete;
  }
  function readingStep(index) {
    readerIndex = index;
    const steps = [
      { selector: '#readerTocToggle', tag: '03 / 03 · 阅读 1 / 3', title: '章节目录', text: '打开目录就能快速跳到想看的章节。EPUB/TXT 支持章节导航。' },
      { selector: '#readerSettingsToggle', tag: '03 / 03 · 阅读 2 / 3', title: '设置舒服的阅读排版', text: '这里可以调整字体、行距和阅读主题。使用底部工具栏也能快速切换主题。' },
      { selector: '#readerPositionHistoryToggle', tag: '03 / 03 · 阅读 3 / 3', title: '进度跳错也能找回', text: '打开位置历史可查看跳转记录。通过目录、书签或进度条误跳转后，还可以使用返回按钮。普通翻页不会逐页记为跳转。' }
    ];
    const spec = steps[index];
    if (!spec) { complete(); return; }
    persist({ phase: 'reader-guide', readerIndex: index, completed: false });
    spotlight(spec.selector, {
      ...spec, onClick: () => window.setTimeout(() => readingStep(index + 1), 120),
      onNext: () => readingStep(index + 1), onMissing: () => readingStep(index + 1)
    });
  }
  function showHelp(tab = 'start') {
    helpTab = HELP[tab] ? tab : 'start';
    const root = mount('yomi-guide-help', '<div class="yomi-guide-scrim"></div><section class="yomi-guide-help-dialog" role="dialog" aria-modal="true" aria-labelledby="yomiHelpTitle"><header><div><p class="yomi-guide-kicker">YOMI READER</p><h2 id="yomiHelpTitle">使用帮助</h2><p>无须联网，随时查看。</p></div><button class="yomi-guide-icon" data-guide-close aria-label="关闭帮助">×</button></header><div class="yomi-guide-help-layout"><nav class="yomi-guide-help-nav" aria-label="帮助分类"></nav><article class="yomi-guide-help-body" id="yomiHelpContent" tabindex="0"></article></div><footer><button class="yomi-guide-quiet" data-guide-replay>重新体验新手引导</button><button class="yomi-guide-primary" data-guide-reader>阅读器操作教学</button></footer></section>');
    function selectHelp(next) {
      helpTab = next;
      root.querySelector('.yomi-guide-help-nav').innerHTML = Object.keys(HELP).map(key => '<button type="button" data-help-tab="' + key + '"' + (key === next ? ' aria-current="page"' : '') + '>' + HELP[key].title + '</button>').join('');
      root.querySelector('#yomiHelpContent').innerHTML = '<h3>' + HELP[next].title + '</h3>' + HELP[next].html;
    }
    root.querySelector('.yomi-guide-help-nav').onclick = e => { const button = e.target.closest('[data-help-tab]'); if (button) selectHelp(button.dataset.helpTab); };
    root.querySelector('[data-guide-close]').onclick = () => clear();
    root.querySelector('[data-guide-replay]').onclick = welcome;
    const readerButton = root.querySelector('[data-guide-reader]');
    const currentFormat = getReaderFormat?.();
    readerButton.disabled = !currentFormat;
    readerButton.title = currentFormat ? '在当前阅读器中开始教学' : '打开一本书后才能体验';
    readerButton.onclick = () => currentFormat === 'pdf' ? pdfGuide() : readingStep(0);
    selectHelp(helpTab);
  }
  function maybeAutoStart({ booksCount = 0, tasksCount = 0 } = {}) {
    const storedState = readState();
    let legacy = false;
    try { legacy = LEGACY_KEYS.some(key => localStorage.getItem(key) !== null); } catch (_) {}
    if (shouldAutoLaunch({ storedState, booksCount, tasksCount, hasLegacyPreferences: legacy })) welcome();
  }
  return {
    maybeAutoStart,
    start: welcome,
    showHelp,
    onBookImported() { if (state.phase === 'waiting-book' || state.phase === 'import') bookGuide(); },
    onReaderReady(format) {
      if (state.phase === 'reader-pending' || state.phase === 'open-book') {
        if (String(format).toLowerCase() === 'pdf') pdfGuide();
        else readingStep(0);
      }
    },
    onReaderClosed() {
      if (state.phase === 'reader-guide' || state.phase === 'pdf-info') {
        persist({ phase: 'reader-pending' });
        clear();
      }
    }
  };
}
