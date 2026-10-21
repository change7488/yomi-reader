// Shared reader controller for Windows Electron and Android Capacitor.
// All EPUB/TXT parsing, positions, reader UI and event bindings live here.
import { parseReaderDocument } from './index.js';
import { advanceReadingState } from './position-services.js';
import { isAndroidApp } from '../platform/mobile-shell.js';
import { renderMobilePdf } from '../platform/pdf-viewer.js';
import { installReadingSurface } from './reading-interactions.js';

export function createReaderController({ state, $, esc, toast, put, onboarding, renderDashboard, markReaderActivity, recordPageTurn }) {
  function currentReaderStyle() { return state.readerBook?.readerStyle || { fontSize: 17, lineHeight: 1.95, width: 1400, sideMargin: 32, indent: true, theme: 'paper', turnMode: 'page' }; }
  function applyReaderStyle() {
    const style = { sideMargin: 32, ...currentReaderStyle() }, stage = $('readerStage');
    stage.style.fontSize = `${style.fontSize}px`; stage.style.lineHeight = String(style.lineHeight); stage.style.width = `min(${style.width}px, 100%)`;
    stage.style.paddingLeft = `${style.sideMargin}px`; stage.style.paddingRight = `${style.sideMargin}px`;
    stage.classList.toggle('no-indent', !style.indent); $('readerModal').dataset.readerTheme = style.theme || 'paper';
    $('readerFontRange').value = style.fontSize; $('readerFontValue').textContent = `${style.fontSize} px`;
    $('readerLineRange').value = Math.round(style.lineHeight * 10); $('readerLineValue').textContent = Number(style.lineHeight).toFixed(2);
    $('readerWidthRange').max = String(Math.max(1600, Math.ceil((window.innerWidth - 24) / 20) * 20));
    $('readerWidthRange').value = style.width; $('readerWidthValue').textContent = `${style.width} px`;
    $('readerMarginRange').value = style.sideMargin; $('readerMarginValue').textContent = `${style.sideMargin} px`;
    $('readerIndentToggle').checked = !!style.indent; $('readerThemeSelect').value = style.theme || 'paper'; $('readerTurnMode').value = style.turnMode || 'page';
    document.querySelectorAll('[data-reader-theme-option]').forEach(button => {
      const selected = button.dataset.readerThemeOption === (style.theme || 'paper');
      button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    });
  }
  async function reflowReaderPreservingPosition(update) {
    const anchor = state.readerChapters.length ? captureReaderAnchor() : null;
    update();
    if (!anchor) return;
    const token = state.styleRestoreToken = (state.styleRestoreToken || 0) + 1;
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (token !== state.styleRestoreToken) return;
    await restoreReaderAnchor(anchor);
    await persistReaderPosition(false);
  }
  async function updateReaderStyle(key, value) {
    const book = state.readerBook; if (!book) return;
    book.readerStyle = { ...currentReaderStyle(), [key]: value };
    await reflowReaderPreservingPosition(applyReaderStyle);
    await put('books', book);
  }
  function renderReaderBookmarks() {
    const bookmarks = state.readerBook?.bookmarks || [];
    $('readerBookmarkItems').innerHTML = bookmarks.map((mark, index) => `<div class="bookmark-row"><button class="bookmark-jump" data-bookmark-index="${index}"><b>${esc(mark.chapterTitle)}</b><span>${new Date(mark.createdAt).toLocaleString()} · ${Math.round(mark.scroll || 0)} px</span></button><button class="bookmark-delete" data-bookmark-delete="${index}" aria-label="删除书签">×</button></div>`).join('') || '<p class="gallery-empty">还没有书签。阅读时点击顶部 ☆ 可保存当前位置。</p>';
  }
  function installReaderControls() {
    $('readerModal').querySelector('.reader-top').insertAdjacentHTML('beforeend', '<button class="reader-tool reader-fullscreen" id="readerFullscreenToggle" title="切换全屏">⛶ <span>全屏</span></button>');
    $('readerSettings').querySelector('.reader-toc-head').insertAdjacentHTML('afterend', '<label>滚动方式<select id="readerTurnMode"><option value="page">滚动翻页（带动画）</option><option value="continuous">连续滚动</option></select></label>');
    const widthLabel = $('readerWidthRange').closest('label');
    widthLabel.childNodes[0].textContent = '正文最大宽度 ';
    widthLabel.insertAdjacentHTML('afterend', '<label>正文左右留白 <span id="readerMarginValue">32 px</span><input type="range" id="readerMarginRange" min="0" max="240" step="4" value="32"></label><div class="reader-width-actions"><small>最大宽度控制正文栏宽度；左右留白控制文字距正文栏边缘的距离。</small><button id="readerWidthFillBtn" class="secondary-button">铺满窗口</button></div>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-notes-panel" id="readerNotesPanel"><div class="reader-toc-head"><strong>本书笔记</strong><button id="readerNotesClose" aria-label="关闭笔记">×</button></div><div class="reader-note-composer"><div id="readerNoteQuote" class="reader-note-quote">选择正文后添加摘录，也可以直接写本章笔记。</div><textarea id="readerNoteInput" rows="3" placeholder="写下你的想法…"></textarea><button id="readerNoteSave" class="primary-button">保存笔记</button></div><div id="readerNotesList"></div></aside>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-search-panel" id="readerSearchPanel"><div class="reader-toc-head"><strong>查找正文</strong><button id="readerSearchClose" aria-label="关闭搜索">×</button></div><label class="reader-search-field"><input id="readerSearchInput" type="search" placeholder="输入书中的关键词…"><span id="readerSearchCount">输入至少 2 个字</span></label><div id="readerSearchResults"></div></aside>');
    $('readerModal').insertAdjacentHTML('beforeend', `<footer class="reader-dock" id="readerDock"><div class="reader-theme-picker" id="readerThemePicker" role="group" aria-label="阅读主题"><div class="reader-theme-picker-heading"><strong>选择阅读主题</strong><span>悬停预览 · 点击使用</span></div><div class="reader-theme-options"><button class="reader-theme-option" data-reader-theme-option="paper" data-theme-name="暖纸" style="--theme-bg:#f7f5ee;--theme-ink:#373a35"><i><b></b><b></b><b></b></i><span>暖纸</span></button><button class="reader-theme-option" data-reader-theme-option="ivory" data-theme-name="象牙白" style="--theme-bg:#fffdf7;--theme-ink:#38342c"><i><b></b><b></b><b></b></i><span>象牙白</span></button><button class="reader-theme-option" data-reader-theme-option="sepia" data-theme-name="羊皮纸" style="--theme-bg:#f1e5ce;--theme-ink:#514333"><i><b></b><b></b><b></b></i><span>羊皮纸</span></button><button class="reader-theme-option" data-reader-theme-option="mint" data-theme-name="薄荷绿" style="--theme-bg:#eff6f0;--theme-ink:#2c3931"><i><b></b><b></b><b></b></i><span>薄荷绿</span></button><button class="reader-theme-option" data-reader-theme-option="gray" data-theme-name="雾灰" style="--theme-bg:#edf0f1;--theme-ink:#30363a"><i><b></b><b></b><b></b></i><span>雾灰</span></button><button class="reader-theme-option" data-reader-theme-option="lavender" data-theme-name="淡紫" style="--theme-bg:#f2eff8;--theme-ink:#373342"><i><b></b><b></b><b></b></i><span>淡紫</span></button><button class="reader-theme-option" data-reader-theme-option="night" data-theme-name="夜间" style="--theme-bg:#17191b;--theme-ink:#dedbd3"><i><b></b><b></b><b></b></i><span>夜间</span></button><button class="reader-theme-option" data-reader-theme-option="forest" data-theme-name="深林" style="--theme-bg:#1d2924;--theme-ink:#d8e5dc"><i><b></b><b></b><b></b></i><span>深林</span></button></div></div><div class="reader-dock-actions"><button id="readerDockToc">▤ <span>目录</span></button><button id="readerDockNote">▧ <span>笔记</span></button><button id="readerDockBookmark">▱ <span>书签</span></button><button id="readerDockTheme" aria-expanded="false" aria-controls="readerThemePicker">☼ <span>主题</span></button><button id="readerDockSettings">Aa <span>设置</span></button><button id="readerDockSpeak">♫ <span>朗读</span></button></div><div class="reader-progress-row"><button id="readerProgressPrev" title="上一页">‹</button><div class="reader-progress-info"><span id="readerProgressLabel">0%</span><span id="readerProgressChapter"></span></div><input type="range" id="readerProgressRange" min="0" max="1000" value="0" aria-label="整本书阅读进度"><button id="readerProgressNext" title="下一页">›</button></div></footer>`);
    $('readerDock').querySelector('.reader-dock-actions').insertAdjacentHTML('beforeend', '<button id="readerDockSearch" title="搜索本书">⌕ <span>查找</span></button><button id="readerPositionBack" title="返回上一个阅读位置">↶ <span>上一个位置</span></button><button id="readerPositionForward" title="前进到下一个阅读位置">↷ <span>前进</span></button><button id="readerPositionHistoryToggle" title="阅读位置历史">◷ <span>位置历史</span></button>');
    $('readerDock').insertAdjacentHTML('beforeend', '<div class="reader-seek-preview hidden" id="readerSeekPreview"><div><span id="readerSeekOrigin"></span><strong id="readerSeekTarget"></strong></div><button class="secondary-button" id="readerSeekCancel">取消预览</button><button class="primary-button" id="readerSeekConfirm">跳转至此处</button></div>');
    $('readerDock').insertAdjacentHTML('beforeend', '<div class="reader-undo-notice hidden" id="readerUndoNotice"><span id="readerUndoMessage"></span><button id="readerUndoAction">撤回</button></div>');
    $('readerModal').querySelector('.reader-layout').insertAdjacentHTML('beforeend', '<aside class="reader-position-history" id="readerPositionHistory"><div class="reader-toc-head"><strong>阅读位置历史</strong><button id="readerPositionHistoryClose" aria-label="关闭位置历史">×</button></div><div id="readerPositionHistoryItems"></div></aside>');
  }
  function renderReaderNotes() {
    const notes = state.readerBook?.notes || [];
    $('readerNotesList').innerHTML = notes.map((note, index) => `<article class="reader-note"><header><b>${esc(note.chapterTitle)}</b><div><button data-note-jump="${index}" title="定位到笔记位置">定位</button><button data-note-delete="${index}" aria-label="删除笔记">×</button></div></header>${note.quote ? `<blockquote>${esc(note.quote)}</blockquote>` : ''}<p>${esc(note.text)}</p><small>${new Date(note.createdAt).toLocaleString()}</small></article>`).join('') || '<p class="gallery-empty">还没有笔记。选择正文后点击“笔记”，可保存摘录和想法。</p>';
  }
  function renderReaderSearch(query) {
    const term = String(query || '').trim(), panel = $('readerSearchResults');
    if (!term || term.length < 2) { state.readerSearchResults = []; $('readerSearchCount').textContent = '输入至少 2 个字'; panel.innerHTML = '<p class="position-history-empty">搜索结果会显示章节、上下文和位置。</p>'; return; }
    const results = [];
    state.readerChapters.forEach((chapter, chapterIndex) => (chapter.blocks || []).forEach((block, blockIndex) => {
      if (results.length >= 100) return;
      if (block.type !== 'paragraph') return;
      const text = String(block.value || ''), matchIndex = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
      if (matchIndex < 0) return;
      const start = Math.max(0, matchIndex - 35), end = Math.min(text.length, matchIndex + term.length + 55);
      results.push({ chapterTitle: chapter.title, snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, anchor: { fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex, chapterTitle: chapter.title, blockIndex, charOffset: matchIndex, sourceOffset: Number.isFinite(block.sourceOffset) ? block.sourceOffset + matchIndex : null, chapterScrollRatio: 0, progress: (chapterIndex + (blockIndex + 1) / Math.max(1, chapter.blocks.length + 1)) / Math.max(1, state.readerChapters.length) * 100 } });
      if (results.length >= 100) return;
    }));
    state.readerSearchResults = results; $('readerSearchCount').textContent = results.length >= 100 ? '显示前 100 条结果' : `找到 ${results.length} 条结果`;
    panel.innerHTML = results.map((result, index) => `<button class="reader-search-result" data-reader-search-result="${index}"><b>${esc(result.chapterTitle)}</b><span>${esc(result.snippet)}</span></button>`).join('') || '<p class="position-history-empty">没有找到匹配内容。</p>';
  }
  async function addReaderNote() {
    if (!state.readerBook) return;
    state.pendingNoteQuote = window.getSelection()?.toString().trim().slice(0, 1000) || '';
    $('readerNoteQuote').textContent = state.pendingNoteQuote || '未选择正文，将保存为本章笔记。'; $('readerNoteInput').value = '';
    $('readerNotesPanel').classList.add('open'); $('readerNoteInput').focus();
  }
  async function saveReaderNote() {
    const text = $('readerNoteInput').value.trim(); if (!text) { toast('请先写下笔记内容。'); return; }
    const book = state.readerBook; book.notes = book.notes || [];
    book.notes.unshift({ quote: state.pendingNoteQuote, text, chapterIndex: state.readerChapterIndex, chapterTitle: state.readerChapters[state.readerChapterIndex]?.title || 'PDF 文档', anchor: captureReaderAnchor(), createdAt: Date.now() });
    state.pendingNoteQuote = ''; await put('books', book); renderReaderNotes(); $('readerNoteInput').value = ''; $('readerNoteQuote').textContent = '已保存。继续选择正文即可添加下一条笔记。';
  }
  function toggleReaderSpeech() {
    if (!('speechSynthesis' in window)) { toast('当前系统没有可用的语音朗读服务。', 'error'); return; }
    if (state.speechActive) { speechSynthesis.cancel(); state.speechActive = false; $('readerDockSpeak').innerHTML = '♫ <span>朗读</span>'; return; }
    const text = [...$('readerStage').querySelectorAll('p')].map(p => p.textContent).join('\n');
    if (!text.trim()) { toast('当前章节没有可朗读的文字。'); return; }
    const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN';
    utterance.onend = utterance.onerror = () => { state.speechActive = false; $('readerDockSpeak').innerHTML = '♫ <span>朗读</span>'; };
    state.speechActive = true; $('readerDockSpeak').innerHTML = '■ <span>停止朗读</span>'; speechSynthesis.cancel(); speechSynthesis.speak(utterance);
  }
  function animateReaderTurn(direction) {
    const body = $('readerModal').querySelector('.reader-body');
    body.classList.remove('page-turn-next', 'page-turn-prev'); void body.offsetWidth;
    body.classList.add(direction > 0 ? 'page-turn-next' : 'page-turn-prev');
    clearTimeout(state.turnTimer); state.turnTimer = setTimeout(() => body.classList.remove('page-turn-next', 'page-turn-prev'), 360);
  }
  function moveReaderPage(direction) {
    const stage = $('readerStage'), maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
    const step = Math.max(220, stage.clientHeight * .82), target = stage.scrollTop + direction * step;
    if (direction > 0 && stage.scrollTop >= maxScroll - 8 && state.readerChapterIndex < state.readerChapters.length - 1) {
      animateReaderTurn(direction); renderChapter(state.readerChapterIndex + 1); recordPageTurn(); persistReaderPosition(); return;
    }
    if (direction < 0 && stage.scrollTop <= 8 && state.readerChapterIndex > 0) {
      animateReaderTurn(direction); renderChapter(state.readerChapterIndex - 1); recordPageTurn();
      requestAnimationFrame(() => { stage.scrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight); updateReaderProgressUI(); persistReaderPosition(); }); return;
    }
    const next = Math.min(maxScroll, Math.max(0, target)); if (next === stage.scrollTop) return;
    animateReaderTurn(direction); stage.scrollTo({ top: next, behavior: 'smooth' }); recordPageTurn();
  }
  async function toggleReaderFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('readerModal').requestFullscreen({ navigationUI: 'hide' });
    } catch (error) { toast(`无法切换全屏：${error.message}`, 'error'); }
  }
  async function addReaderBookmark() {
    const book = state.readerBook; if (!book || !state.readerChapters.length) return;
    const chapter = state.readerChapters[state.readerChapterIndex], stage = $('readerStage');
    book.bookmarks = book.bookmarks || []; book.bookmarks.unshift({ chapterIndex: state.readerChapterIndex, chapterTitle: chapter.title, scroll: stage.scrollTop, anchor: captureReaderAnchor(), createdAt: Date.now() });
    await put('books', book); renderReaderBookmarks(); $('readerBookmarks').classList.add('open'); toast('已保存当前位置书签。');
  }
  function renderChapter(index, restoreScroll = false) {
    if (!state.readerChapters.length) return;
    const chapter = state.readerChapters[index]; if (!chapter) return;
    state.readerChapterIndex = index;
    if (state.readerBook) state.readerBook.lastChapterTitle = chapter.title;
    $('readerChapterTitle').textContent = chapter.title;
    $('readerChapterLabel').textContent = `${index + 1} / ${state.readerChapters.length}`;
    $('readerStage').innerHTML = (chapter.blocks || []).map((block, blockIndex) => {
      if (block.type === 'image') {
        const imageIndex = state.readerImages.findIndex(image => image.src === block.src);
        return `<figure class="reader-illustration" data-reader-block="${blockIndex}"><img src="${esc(block.src)}" alt="${esc(block.alt)}" data-reader-image="${imageIndex}">${block.alt ? `<figcaption>${esc(block.alt)}</figcaption>` : ''}</figure>`;
      }
      const sourceOffset = Number.isFinite(block.sourceOffset) ? ` data-reader-source-offset="${block.sourceOffset}"` : '';
      return `<p data-reader-block="${blockIndex}"${sourceOffset}>${esc(block.value || '')}</p>`;
    }).join('');
    applyReaderStyle();
    $('readerPrev').disabled = index <= 0; $('readerNext').disabled = index >= state.readerChapters.length - 1;
    $('readerTocItems').innerHTML = state.readerChapters.map((ch, i) => `<button class="toc-item ${i === index ? 'selected' : ''}" style="padding-left:${10 + Math.min(4, ch.depth || 0) * 14}px" data-chapter-index="${i}"><span>${String(i + 1).padStart(2, '0')}</span><b>${esc(ch.title)}</b></button>`).join('');
    $('readerStage').scrollTop = restoreScroll && state.readerBook?.chapterIndex === index ? (state.readerBook.chapterScroll || 0) : 0;
    $('readerToc').classList.remove('open');
    updateReaderProgressUI();
  }
  function releaseReaderAssets() { for (const url of state.readerObjectUrls) URL.revokeObjectURL(url); state.readerObjectUrls = []; state.readerImages = []; }
  function showReaderImage(index) {
    if (!state.readerImages.length) return;
    state.activeImageIndex = (index + state.readerImages.length) % state.readerImages.length;
    const image = state.readerImages[state.activeImageIndex];
    $('readerLightboxImage').src = image.src; $('readerLightboxImage').alt = image.alt || `插图 ${state.activeImageIndex + 1}`;
    $('readerLightboxCaption').textContent = `${image.chapterTitle} · ${state.activeImageIndex + 1} / ${state.readerImages.length}${image.alt ? ` · ${image.alt}` : ''}`;
    $('readerLightbox').classList.remove('original-size'); $('readerImageScaleToggle').textContent = '原始尺寸';
    $('readerLightbox').classList.add('open');
  }
  function renderReaderGallery() {
    $('readerGalleryToggle').disabled = !state.readerImages.length;
    $('readerGalleryItems').innerHTML = state.readerImages.map((image, i) => `<button class="gallery-image" data-gallery-image="${i}" title="${esc(image.alt || `插图 ${i + 1}`)}"><img src="${esc(image.src)}" alt=""><span><b>${esc(image.chapterTitle)}</b><small>插图 ${i + 1}${image.alt ? ` · ${esc(image.alt)}` : ''}</small></span></button>`).join('') || '<p class="gallery-empty">这本书没有可识别的 EPUB 插图。</p>';
  }
  function readerTextOptions() {
    return state.readerBook?.readerTextSettings || { encoding: 'utf-8', pattern: '' };
  }
  async function previewTextChapters() {
    const encoding = $('txtEncodingSelect').value, pattern = $('txtPatternInput').value.trim();
    try {
      const doc = await parseReaderDocument(state.readerBook.file, 'txt', { encoding, pattern: pattern || undefined });
      $('txtPreview').innerHTML = `<strong>识别到 ${doc.chapters.length} 个章节</strong><ol>${doc.chapters.slice(0, 16).map(ch => `<li>${esc(ch.title)}</li>`).join('')}</ol>${doc.chapters.length > 16 ? `<small>另有 ${doc.chapters.length - 16} 章未显示</small>` : ''}`;
      return doc;
    } catch (error) { $('txtPreview').innerHTML = `<p class="txt-preview-error">规则或编码无效：${esc(error.message)}</p>`; return null; }
  }
  async function applyTextChapterSettings() {
    const book = state.readerBook, pattern = $('txtPatternInput').value.trim(), encoding = $('txtEncodingSelect').value;
    const doc = await previewTextChapters(); if (!doc) return;
    state.readerChapters = doc.chapters; state.readerImages = [];
    book.readerTextSettings = { encoding, pattern };
    state.readerChapterIndex = Math.min(state.readerChapterIndex, state.readerChapters.length - 1);
    await put('books', book); renderReaderGallery(); renderChapter(state.readerChapterIndex);
    $('readerSettings').classList.remove('open'); toast(`已应用章节识别：${doc.chapters.length} 章。`);
  }
  function readerBlockWeight(block) { return Math.max(1, String(block?.value || '').length); }
  function readerChapterWeight(chapter) { return Math.max(1, (chapter?.blocks || []).reduce((sum, block) => sum + readerBlockWeight(block), 0)); }
  function readerPositionProgress(chapterIndex, blockIndex, charOffset) {
    const chapters = state.readerChapters; if (!chapters.length) return 0;
    const total = chapters.reduce((sum, chapter) => sum + readerChapterWeight(chapter), 0);
    let preceding = 0;
    for (let index = 0; index < Math.min(chapterIndex, chapters.length); index++) preceding += readerChapterWeight(chapters[index]);
    const chapter = chapters[chapterIndex], blocks = chapter?.blocks || [];
    for (let index = 0; index < Math.min(blockIndex, blocks.length); index++) preceding += readerBlockWeight(blocks[index]);
    const currentBlock = blocks[blockIndex];
    if (currentBlock?.type === 'paragraph') preceding += Math.min(readerBlockWeight(currentBlock), Math.max(0, Number(charOffset) || 0));
    return Math.max(0, Math.min(100, preceding / Math.max(1, total) * 100));
  }
  function currentReaderProgress() { return captureReaderAnchor()?.progress || 0; }
  function captureReaderAnchor() {
    const book = state.readerBook, stage = $('readerStage'), chapter = state.readerChapters[state.readerChapterIndex];
    if (!book || !chapter) return null;
    const stageRect = stage.getBoundingClientRect(), paragraphs = [...stage.querySelectorAll('[data-reader-block]')];
    const paragraph = paragraphs.find(item => item.getBoundingClientRect().bottom > stageRect.top + 2) || paragraphs.at(-1);
    const text = paragraph?.textContent || '', rect = paragraph?.getBoundingClientRect();
    const verticalRatio = rect?.height ? Math.max(0, Math.min(1, (stageRect.top - rect.top) / rect.height)) : 0;
    const charOffset = Math.max(0, Math.min(text.length, Math.round(text.length * verticalRatio)));
    const maxScroll = Math.max(1, stage.scrollHeight - stage.clientHeight);
    const blockIndex = paragraph ? Number(paragraph.dataset.readerBlock) : 0;
    const progress = readerPositionProgress(state.readerChapterIndex, blockIndex, charOffset);
    const sourceOffset = paragraph?.dataset.readerSourceOffset !== undefined
      ? Number(paragraph.dataset.readerSourceOffset) + charOffset : null;
    return {
      fileHash: book.hash || '', chapterId: chapter.id || '', chapterIndex: state.readerChapterIndex,
      chapterTitle: chapter.title || '', blockIndex,
      charOffset, sourceOffset: Number.isFinite(sourceOffset) ? sourceOffset : null,
      chapterScrollRatio: Math.max(0, Math.min(1, stage.scrollTop / maxScroll)), progress,
      context: text.slice(Math.max(0, charOffset - 24), charOffset + 48), capturedAt: Date.now()
    };
  }
  function persistedReaderSnapshot(book, readingState, anchor) {
    return { readingState, chapterIndex: anchor.chapterIndex, chapterScroll: $('readerStage').scrollTop, progress: anchor.progress,
      lastRead: Date.now(), lastChapterTitle: anchor.chapterTitle || book.lastChapterTitle };
  }
  async function persistReaderPosition(immediate = false) {
    const book = state.readerBook; if (!book || !state.readerChapters.length) return;
    const anchor = captureReaderAnchor(); if (!anchor) return;
    const timestamp = Date.now(), previous = book.readingState || {};
    const readingState = advanceReadingState(previous, anchor, timestamp);
    readingState.navigation = state.navigationService.export(book.id);
    readingState.sessions = readingState.navigation.sessions;
    const session = readingState.sessions.find(item => item.id === state.activeReaderSessionId);
    if (session) session.endAnchor = anchor;
    book.readingState = readingState; book.chapterIndex = anchor.chapterIndex; book.chapterScroll = $('readerStage').scrollTop;
    book.progress = Math.floor(anchor.progress); book.lastRead = timestamp; book.lastChapterTitle = anchor.chapterTitle;
    updateReaderProgressUI(); renderReaderPositionHistory();
    const snapshot = persistedReaderSnapshot(book, readingState, anchor);
    state.positionService?.schedule(book.id, snapshot);
    if (immediate) await state.positionService?.flush(book.id);
  }
  function restoreReaderAnchor(anchor, { save = false } = {}) {
    return new Promise(resolve => {
      if (!anchor || !state.readerBook || !state.readerChapters.length) { resolve(false); return; }
      const sameFile = !anchor.fileHash || !state.readerBook.hash || anchor.fileHash === state.readerBook.hash;
      let index = sameFile && anchor.chapterId ? state.readerChapters.findIndex(chapter => chapter.id === anchor.chapterId) : -1;
      if (index < 0) index = Math.max(0, Math.min(state.readerChapters.length - 1, Number(anchor.chapterIndex) || 0));
      state.restoringPosition = true; renderChapter(index, false);
      requestAnimationFrame(() => {
        const stage = $('readerStage'), paragraphs = [...stage.querySelectorAll('[data-reader-block]')];
        let paragraph = null, charOffset = Number(anchor.charOffset) || 0;
        if (sameFile && Number.isFinite(anchor.sourceOffset)) {
          const sourceBlocks = paragraphs.filter(item => Number.isFinite(Number(item.dataset.readerSourceOffset)));
          paragraph = sourceBlocks.filter(item => Number(item.dataset.readerSourceOffset) <= anchor.sourceOffset).at(-1) || sourceBlocks[0];
          if (paragraph) charOffset = Math.max(0, anchor.sourceOffset - Number(paragraph.dataset.readerSourceOffset));
        }
        if (!paragraph && sameFile) paragraph = paragraphs.find(item => Number(item.dataset.readerBlock) === Number(anchor.blockIndex));
        const maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
        stage.scrollTop = 0;
        if (paragraph) {
          const textNode = paragraph.firstChild;
          if (textNode?.nodeType === Node.TEXT_NODE && textNode.length) {
            const offset = Math.max(0, Math.min(textNode.length - 1, charOffset)), range = document.createRange();
            range.setStart(textNode, offset); range.setEnd(textNode, Math.min(textNode.length, offset + 1));
            const rangeRect = range.getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
            if (rangeRect.height) stage.scrollTop = Math.max(0, Math.min(maxScroll, stage.scrollTop + rangeRect.top - stageRect.top));
          } else { const targetRect = paragraph.getBoundingClientRect(), stageRect = stage.getBoundingClientRect(); stage.scrollTop = Math.max(0, Math.min(maxScroll, stage.scrollTop + targetRect.top - stageRect.top)); }
        } else stage.scrollTop = Math.max(0, Math.min(maxScroll, (Number(anchor.chapterScrollRatio) || 0) * maxScroll));
        updateReaderProgressUI(); state.restoringPosition = false;
        if (save) persistReaderPosition(true).catch(error => console.warn('恢复位置保存失败', error));
        resolve(true);
      });
    });
  }
  function updateReaderProgressUI() {
    if (!state.readerChapters.length || !$('readerProgressRange')) return;
    const stage = $('readerStage');
    const percent = currentReaderProgress();
    const range = $('readerProgressRange'); range.value = Math.round(percent * 10);
    range.style.setProperty('--progress', `${percent}%`);
    const pageCount = Math.max(1, Math.ceil(stage.scrollHeight / Math.max(1, stage.clientHeight))), pageIndex = Math.min(pageCount, Math.floor(stage.scrollTop / Math.max(1, stage.clientHeight)) + 1);
    $('readerProgressLabel').textContent = `${percent.toFixed(1)}%${currentReaderStyle().turnMode === 'page' ? ` · ${pageIndex}/${pageCount} 页` : ''}`;
    $('readerProgressChapter').textContent = state.readerChapters[state.readerChapterIndex]?.title || '';
    const history = state.navigationService.state(state.readerBook.id);
    $('readerPositionBack').disabled = history.undoStack.length === 0;
    $('readerPositionForward').disabled = history.redoStack.length === 0;
  }
  function readerAnchorLabel(anchor) { return `${anchor?.chapterTitle || '正文'} · ${Number(anchor?.progress || 0).toFixed(1)}%`; }
  function progressTarget(value) {
    const chapters = state.readerChapters, total = chapters.length; if (!total) return null;
    const ratio = Math.max(0, Math.min(1, value / 1000)), weights = chapters.map(readerChapterWeight), documentWeight = weights.reduce((sum, item) => sum + item, 0);
    let remaining = ratio * documentWeight, index = total - 1;
    for (let chapterIndex = 0; chapterIndex < total; chapterIndex++) {
      if (remaining <= weights[chapterIndex] || chapterIndex === total - 1) { index = chapterIndex; break; }
      remaining -= weights[chapterIndex];
    }
    const chapter = chapters[index], blocks = chapter.blocks || []; let local = Math.max(0, Math.min(weights[index], remaining)), blockIndex = 0, charOffset = 0;
    for (let current = 0; current < blocks.length; current++) {
      const weight = readerBlockWeight(blocks[current]);
      if (local <= weight || current === blocks.length - 1) { blockIndex = current; charOffset = blocks[current]?.type === 'paragraph' ? Math.min(weight, local) : 0; break; }
      local -= weight;
    }
    const block = blocks[blockIndex];
    const anchor = { fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex: index, chapterTitle: chapter.title, blockIndex, charOffset, sourceOffset: block?.type === 'paragraph' && Number.isFinite(block.sourceOffset) ? block.sourceOffset + charOffset : null, chapterScrollRatio: remaining / Math.max(1, weights[index]), progress: ratio * 100 };
    return { index, ratio, anchor };
  }
  function renderSeekPreview(value) {
    const target = progressTarget(value); if (!target) return;
    state.pendingSeekValue = value; $('readerSeekPreview').classList.remove('hidden');
    const current = captureReaderAnchor(); $('readerSeekOrigin').textContent = `原位置：${readerAnchorLabel(current)}`;
    $('readerSeekTarget').textContent = `预览目标：${state.readerChapters[target.index]?.title || '正文'} · ${(target.ratio * 100).toFixed(1)}%`;
    $('readerSeekConfirm').disabled = Math.abs((current?.progress || 0) - target.ratio * 100) < .15;
  }
  function queueReaderNavigation(action) {
    const task = (state.navigationTask || Promise.resolve()).catch(() => {}).then(action);
    state.navigationTask = task.catch(error => { console.warn('阅读位置跳转失败', error); toast(`阅读位置跳转失败：${error.message || error}`, 'error'); });
    return state.navigationTask;
  }
  async function navigateReaderToAnchor(targetAnchor, eventType) {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, from = captureReaderAnchor(); if (!book || !from || !targetAnchor) return;
      if (Math.abs((from.progress || 0) - (targetAnchor.progress || 0)) < .1 && from.chapterId === targetAnchor.chapterId && from.blockIndex === targetAnchor.blockIndex) return;
      await persistReaderPosition(true);
      await restoreReaderAnchor(targetAnchor);
      const to = captureReaderAnchor(), entry = state.navigationService.recordJump(book.id, from, to, eventType);
      if (!entry) { await persistReaderPosition(true); return; }
      await persistReaderPosition(true); showReaderUndoNotice(from, to); renderReaderPositionHistory();
    });
  }
  async function confirmProgressSeek() {
    return queueReaderNavigation(async () => {
      const target = progressTarget(state.pendingSeekValue); if (!target || !state.readerBook) return;
      const from = captureReaderAnchor(); await persistReaderPosition(true);
      animateReaderTurn(target.ratio * 100 >= (from?.progress || 0) ? 1 : -1);
      await restoreReaderAnchor(target.anchor);
      state.pendingSeekValue = null; $('readerSeekPreview').classList.add('hidden');
      const to = captureReaderAnchor(), entry = state.navigationService.recordJump(state.readerBook.id, from, to, '进度条');
      await persistReaderPosition(true);
      if (entry) showReaderUndoNotice(from, to);
      renderReaderPositionHistory();
    });
  }
  async function navigateReaderBack() {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, current = captureReaderAnchor(); if (!book || !current) return;
      const target = state.navigationService.back(book.id, current); if (!target) { toast('没有可返回的阅读位置。'); return; }
      await restoreReaderAnchor(target); await persistReaderPosition(true); renderReaderPositionHistory();
    });
  }
  async function navigateReaderForward() {
    return queueReaderNavigation(async () => {
      const book = state.readerBook, current = captureReaderAnchor(); if (!book || !current) return;
      const target = state.navigationService.forward(book.id, current); if (!target) { toast('没有可前进的阅读位置。'); return; }
      await restoreReaderAnchor(target); await persistReaderPosition(true); renderReaderPositionHistory();
    });
  }
  function showReaderUndoNotice(from, to) {
    $('readerUndoMessage').textContent = `已跳转到 ${readerAnchorLabel(to)}`;
    $('readerUndoNotice').classList.remove('hidden'); clearTimeout(state.undoNoticeTimer);
    state.undoNoticeTimer = setTimeout(() => $('readerUndoNotice').classList.add('hidden'), 6500);
    $('readerUndoAction').onclick = () => { $('readerUndoNotice').classList.add('hidden'); navigateReaderBack(); };
  }
  function renderReaderPositionHistory() {
    const panel = $('readerPositionHistoryItems'); if (!panel || !state.readerBook) return;
    if (state.readerBook.ext?.toLowerCase() === 'pdf') {
      panel.innerHTML = '<p class="position-history-empty">PDF 当前使用系统内置预览器，暂不提供精确位置锚点、跳转历史和撤回。</p>';
      $('readerPositionBack').disabled = $('readerPositionForward').disabled = true;
      return;
    }
    const saved = state.navigationService.export(state.readerBook.id), reading = state.readerBook.readingState || {};
    $('readerPositionBack').disabled = saved.undoStack.length === 0;
    $('readerPositionForward').disabled = saved.redoStack.length === 0;
    const entries = [...saved.entries].reverse();
    panel.innerHTML = `<section class="position-current"><strong>当前阅读位置</strong><span>${esc(readerAnchorLabel(reading.currentAnchor || captureReaderAnchor()))}</span><small>历史最远进度 ${Number(reading.furthestProgress || 0).toFixed(1)}%</small></section><h3>最近跳转</h3>${entries.length ? entries.map(entry => `<button class="position-history-item" data-position-entry="${esc(entry.id)}"><i>↶</i><span><b>${esc(entry.targetAnchor?.chapterTitle || '正文')}</b><small>${esc(entry.eventType)} · ${new Date(entry.createdAt).toLocaleString()}</small></span><em>${Number(entry.targetAnchor?.progress || 0).toFixed(1)}%</em></button>`).join('') : '<p class="position-history-empty">目录、书签或进度条跳转后会记录在这里。</p>'}<h3>最近阅读会话</h3>${saved.sessions.length ? [...saved.sessions].reverse().map(session => `<div class="position-session"><span><b>${new Date(session.startedAt).toLocaleString()}</b><small>${session.endedAt ? '已结束' : '本次阅读'} · 起点 ${esc(session.startAnchor?.chapterTitle || '正文')} ${Number(session.startAnchor?.progress || 0).toFixed(1)}%</small></span><button data-session-start="${esc(session.id)}">起点</button>${session.endAnchor ? `<button data-session-end="${esc(session.id)}">终点</button>` : ''}</div>`).join('') : '<p class="position-history-empty">重新打开图书后，会在这里保留最近会话的起点和终点。</p>'}`;
  }
  async function openBook(id) {
    const book = state.books.find(b => b.id === id);
    if (!book) { toast('这是书架样式示例。导入自己的 EPUB、PDF 或 TXT 后即可在此阅读。'); return; }
    if (state.readerBook) await closeReader();
    state.navigationService.load(book.id, book.readingState?.navigation || { sessions: book.readingState?.sessions || [] });
    state.activeReaderSessionId = '';
    if (window.libraDesktop?.isDesktop && book.nativePath) {
      try {
        const stored = await window.libraDesktop.readLibraryBook(book.nativePath);
        if (stored?.bytes) book.file = new File([stored.bytes], book.name, { lastModified: stored.lastModified });
      } catch (e) { console.warn('无法从软件书库读取文件，尝试使用本地缓存', e); }
    }
    if (!book.file) { toast('找不到这本书的本地副本，请在设置中迁移或重新导入。', 'error'); return; }
    releaseReaderAssets(); state.readerBook = book; state.readerChapters = []; markReaderActivity(); $('readerModal').classList.remove('hidden'); $('readerBookName').textContent = book.title;
    $('readerModal').classList.toggle('reader-ui-hidden', isAndroidApp());
    window.dispatchEvent(new CustomEvent('yomi:reader-active', { detail: { active: true } }));
    $('readerToc').classList.remove('open'); $('readerGallery').classList.remove('open'); $('readerSettings').classList.remove('open'); $('readerBookmarks').classList.remove('open'); $('readerNotesPanel').classList.remove('open'); $('readerSearchPanel').classList.remove('open'); $('readerPositionHistory').classList.remove('open'); $('readerLightbox').classList.remove('open'); $('readerTocItems').innerHTML = ''; $('readerChapterTitle').textContent = '';
    clearTimeout(state.readerSearchTimer); $('readerSearchInput').value = ''; state.readerSearchResults = []; renderReaderSearch('');
    const stage = $('readerStage'); stage.innerHTML = ''; stage.onscroll = null;
    const ext = book.ext.toLowerCase();
    $('txtTools').classList.add('hidden');
    renderReaderNotes();
    if (ext === 'pdf') {
      if (isAndroidApp()) {
        try {
          stage.__yomiPdfCleanup = await renderMobilePdf({ stage, file: book.file });
          const restore = Math.max(0, Math.min(1, Number(book.pdfScrollRatio) || 0));
          requestAnimationFrame(() => { stage.scrollTop = (stage.scrollHeight - stage.clientHeight) * restore; });
          stage.onscroll = () => {
            const ratio = stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight);
            book.pdfScrollRatio = Math.min(1, Math.max(0, ratio));
            book.progress = Math.floor(book.pdfScrollRatio * 100);
            clearTimeout(state.progressTimer);
            state.progressTimer = setTimeout(() => put('books', book).catch(error => console.warn('保存 PDF 阅读进度失败', error)), 1200);
          };
        } catch (error) {
          stage.textContent = '无法打开此 PDF：' + (error.message || error);
          console.warn('Android PDF 预览失败', error);
        }
      } else {
        const frame = document.createElement('iframe'); frame.title = book.title;
        frame.src = URL.createObjectURL(book.file);
        state.readerObjectUrls.push(frame.src);
        stage.append(frame);
      }
      $('readerChapterLabel').textContent = 'PDF 文档'; $('readerChapterTitle').textContent = 'PDF 阅读预览'; $('readerPrev').disabled = $('readerNext').disabled = $('readerBookmarkAdd').disabled = true; $('readerTocToggle').disabled = $('readerGalleryToggle').disabled = true; $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = true;
      $('readerDockSearch').disabled = true;
    } else {
      $('readerDockSearch').disabled = false;
      try {
        const textOptions = readerTextOptions();
        $('txtTools').classList.toggle('hidden', ext !== 'txt');
        $('txtEncodingSelect').value = textOptions.encoding || 'utf-8'; $('txtPatternInput').value = textOptions.pattern || ''; $('txtPreview').innerHTML = '';
        const documentData = await parseReaderDocument(book.file, ext, ext === 'txt' ? textOptions : {});
        state.readerChapters = documentData.chapters; state.readerObjectUrls = documentData.objectUrls || [];
        $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = false;
        state.readerImages = state.readerChapters.flatMap((chapter, chapterIndex) => (chapter.blocks || []).filter(block => block.type === 'image').map(block => ({ ...block, chapterIndex, chapterTitle: chapter.title })));
        if (!state.readerChapters.length) state.readerChapters = [{ title: '正文', blocks: [] }];
        $('readerTocToggle').disabled = false;
        renderReaderGallery(); renderReaderBookmarks(); renderReaderNotes(); applyReaderStyle(); $('readerBookmarkAdd').disabled = false;
        const savedAnchor = book.readingState?.currentAnchor;
        const matchingAnchor = savedAnchor && (!savedAnchor.fileHash || savedAnchor.fileHash === book.hash) ? savedAnchor : null;
        const chapterById = matchingAnchor?.chapterId ? state.readerChapters.findIndex(chapter => chapter.id === matchingAnchor.chapterId) : -1;
        const savedIndex = Math.max(0, Math.min(Number.isInteger(chapterById) && chapterById >= 0 ? chapterById : Number.isInteger(book.chapterIndex) ? book.chapterIndex : (book.progress ? Math.floor(book.progress / 100 * state.readerChapters.length) : 0), state.readerChapters.length - 1));
        renderChapter(savedIndex, true);
        if (matchingAnchor) await restoreReaderAnchor(matchingAnchor);
        if (ext === 'txt' && state.readerChapters.length === 1 && state.readerChapters[0].title === '正文') toast('未识别到常见章节标题，已按全文显示；可在目录中查看识别结果。');
      } catch (e) { releaseReaderAssets(); stage.textContent = `无法解析书籍内容：${e.message}`; $('readerChapterLabel').textContent = '解析失败'; $('readerTocToggle').disabled = $('readerGalleryToggle').disabled = true; $('readerProgressRange').disabled = $('readerProgressPrev').disabled = $('readerProgressNext').disabled = true; }
    }
    book.lastRead = Date.now();
      if (state.readerChapters.length) {
      stage.onscroll = () => { markReaderActivity(); updateReaderProgressUI(); if (state.restoringPosition) return; clearTimeout(state.progressTimer); state.progressTimer = setTimeout(() => { persistReaderPosition(false).catch(e => console.warn('保存阅读进度失败', e)); }, 180); };
      const startAnchor = captureReaderAnchor();
      if (startAnchor) { const session = state.navigationService.beginSession(book.id, startAnchor); state.activeReaderSessionId = session.id; await persistReaderPosition(true); }
    } else { await put('books', book); }
    renderReaderPositionHistory();
    onboarding.onReaderReady(ext);
  }
  async function closeReader() {
    const book = state.readerBook; if (!book) { $('readerModal').classList.add('hidden'); return; }
    await state.navigationTask?.catch(() => {});
    if (state.readerBook !== book) return;
    clearTimeout(state.progressTimer);
    $('readerStage').__yomiPdfCleanup?.();
    $('readerStage').__yomiPdfCleanup = null;
    $('readerStage').onscroll = null;
    if (state.readerChapters.length) {
      const anchor = captureReaderAnchor();
      if (state.activeReaderSessionId) state.navigationService.endSession(book.id, state.activeReaderSessionId, anchor);
      await persistReaderPosition(true).catch(error => { console.warn('关闭阅读器时保存位置失败', error); toast('阅读位置暂未保存成功，稍后重新打开时仍会尝试恢复上次保存的位置。', 'error'); });
    } else await state.positionService?.flush(book.id).catch(error => console.warn('关闭时保存队列失败', error));
    if (document.fullscreenElement === $('readerModal')) await document.exitFullscreen().catch(() => {});
    if (state.speechActive) speechSynthesis.cancel(); state.speechActive = false;
    onboarding.onReaderClosed();
    state.activeReaderSessionId = ''; state.readerBook = null; state.readerChapters = [];
    window.dispatchEvent(new CustomEvent('yomi:reader-active', { detail: { active: false } }));
    $('readerModal').classList.remove('reader-ui-hidden');
    $('readerModal').classList.add('hidden'); $('readerLightbox').classList.remove('open'); $('readerPositionHistory').classList.remove('open'); $('readerSeekPreview').classList.add('hidden');
    releaseReaderAssets(); renderDashboard();
  }

  // Reader-specific interactions are isolated from the library/shell bindings.
  function bindReaderEvents() {
    installReadingSurface({
      modal: $('readerModal'),
      body: $('readerModal').querySelector('.reader-body'),
      canTurnPage: () => Boolean(state.readerChapters.length),
      movePage: moveReaderPage,
      markActivity: markReaderActivity,
      mobile: isAndroidApp()
    });
    $('readerBack').onclick = closeReader;
    $('readerFullscreenToggle').onclick = toggleReaderFullscreen;
    $('readerTocToggle').onclick = () => $('readerToc').classList.toggle('open'); $('readerTocClose').onclick = () => $('readerToc').classList.remove('open');
    $('readerGalleryToggle').onclick = () => $('readerGallery').classList.toggle('open'); $('readerGalleryClose').onclick = () => $('readerGallery').classList.remove('open');
    $('readerSettingsToggle').onclick = () => $('readerSettings').classList.toggle('open'); $('readerSettingsClose').onclick = () => $('readerSettings').classList.remove('open');
    $('readerBookmarkAdd').onclick = addReaderBookmark; $('readerBookmarksClose').onclick = () => $('readerBookmarks').classList.remove('open');
    $('readerNotesClose').onclick = () => $('readerNotesPanel').classList.remove('open');
    $('readerDockSearch').onclick = () => { $('readerSearchPanel').classList.toggle('open'); if ($('readerSearchPanel').classList.contains('open')) $('readerSearchInput').focus(); };
    $('readerSearchClose').onclick = () => $('readerSearchPanel').classList.remove('open');
    $('readerSearchInput').oninput = () => { clearTimeout(state.readerSearchTimer); state.readerSearchTimer = setTimeout(() => renderReaderSearch($('readerSearchInput').value), 180); };
    $('readerSearchResults').onclick = e => { const button = e.target.closest('[data-reader-search-result]'); if (!button) return; const result = state.readerSearchResults[Number(button.dataset.readerSearchResult)]; if (!result) return; $('readerSearchPanel').classList.remove('open'); navigateReaderToAnchor(result.anchor, '搜索'); };
    $('readerNoteSave').onclick = saveReaderNote;
    $('readerNotesList').onclick = async e => {
      const jump = e.target.closest('[data-note-jump]');
      if (jump) {
        const note = state.readerBook?.notes?.[Number(jump.dataset.noteJump)]; if (!note) return;
        const anchor = note.anchor || { fileHash: state.readerBook.hash, chapterIndex: note.chapterIndex, chapterId: state.readerChapters[note.chapterIndex]?.id, chapterTitle: note.chapterTitle, blockIndex: 0, charOffset: 0, chapterScrollRatio: 0, progress: note.chapterIndex / Math.max(1, state.readerChapters.length) * 100 };
        $('readerNotesPanel').classList.remove('open'); await navigateReaderToAnchor(anchor, '笔记'); return;
      }
      const button = e.target.closest('[data-note-delete]'); if (!button) return;
      state.readerBook.notes.splice(Number(button.dataset.noteDelete), 1); await put('books', state.readerBook); renderReaderNotes();
    };
    $('readerBookmarkItems').onclick = async e => {
      const remove = e.target.closest('[data-bookmark-delete]');
      if (remove) { state.readerBook.bookmarks.splice(Number(remove.dataset.bookmarkDelete), 1); await put('books', state.readerBook); renderReaderBookmarks(); return; }
      const jump = e.target.closest('[data-bookmark-index]');
      if (jump) { const mark = state.readerBook.bookmarks[Number(jump.dataset.bookmarkIndex)]; if (mark) { const anchor = mark.anchor || { fileHash: state.readerBook.hash, chapterIndex: mark.chapterIndex, chapterId: state.readerChapters[mark.chapterIndex]?.id, chapterTitle: mark.chapterTitle, chapterScrollRatio: Math.min(1, (mark.scroll || 0) / Math.max(1, $('readerStage').scrollHeight - $('readerStage').clientHeight)), progress: state.readerBook.progress || 0 }; $('readerBookmarks').classList.remove('open'); navigateReaderToAnchor(anchor, '书签'); } }
    };
    $('readerFontRange').oninput = e => updateReaderStyle('fontSize', Number(e.target.value));
    $('readerLineRange').oninput = e => updateReaderStyle('lineHeight', Number(e.target.value) / 10);
    $('readerWidthRange').oninput = e => updateReaderStyle('width', Number(e.target.value));
    $('readerMarginRange').oninput = e => updateReaderStyle('sideMargin', Number(e.target.value));
    $('readerWidthFillBtn').onclick = async () => {
      const book = state.readerBook; if (!book) return;
      const width = Math.max(520, Math.floor((window.innerWidth - 24) / 20) * 20);
      book.readerStyle = { ...currentReaderStyle(), width, sideMargin: 0 };
      await reflowReaderPreservingPosition(applyReaderStyle); await put('books', book);
    };
    $('readerIndentToggle').onchange = e => updateReaderStyle('indent', e.target.checked);
    $('readerThemeSelect').onchange = e => updateReaderStyle('theme', e.target.value);
    $('readerTurnMode').onchange = e => updateReaderStyle('turnMode', e.target.value);
    $('readerGalleryItems').onclick = e => { const button = e.target.closest('[data-gallery-image]'); if (button) showReaderImage(Number(button.dataset.galleryImage)); };
    $('readerStage').onclick = e => { const image = e.target.closest('[data-reader-image]'); if (image) showReaderImage(Number(image.dataset.readerImage)); };
    $('readerStage').addEventListener('wheel', e => {
      markReaderActivity();
      if (currentReaderStyle().turnMode !== 'page' || !state.readerChapters.length) return;
      e.preventDefault(); state.wheelDelta += e.deltaY;
      clearTimeout(state.wheelTimer);
      state.wheelTimer = setTimeout(() => { const delta = state.wheelDelta; state.wheelDelta = 0; if (Math.abs(delta) > 24) moveReaderPage(delta > 0 ? 1 : -1); }, 90);
    }, { passive: false });
    $('txtPreviewBtn').onclick = previewTextChapters; $('txtApplyBtn').onclick = applyTextChapterSettings;
    $('readerImageClose').onclick = () => $('readerLightbox').classList.remove('open');
    $('readerImageScaleToggle').onclick = () => { const original = $('readerLightbox').classList.toggle('original-size'); $('readerImageScaleToggle').textContent = original ? '适应窗口' : '原始尺寸'; };
    $('readerImageLocate').onclick = () => {
      const image = state.readerImages[state.activeImageIndex]; if (!image) return;
      renderChapter(image.chapterIndex); $('readerLightbox').classList.remove('open');
      requestAnimationFrame(() => { $('readerStage').querySelector(`[data-reader-image="${state.activeImageIndex}"]`)?.scrollIntoView({ block: 'center' }); persistReaderPosition(); });
    };
    $('readerImagePrev').onclick = () => showReaderImage(state.activeImageIndex - 1); $('readerImageNext').onclick = () => showReaderImage(state.activeImageIndex + 1);
    $('readerDockToc').onclick = () => $('readerToc').classList.toggle('open');
    $('readerDockNote').onclick = addReaderNote;
    $('readerDockBookmark').onclick = addReaderBookmark;
    const themePicker = $('readerThemePicker');
    const closeThemePicker = () => { themePicker.classList.remove('open'); $('readerDockTheme').setAttribute('aria-expanded', 'false'); $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    $('readerDockTheme').onclick = () => { const open = themePicker.classList.toggle('open'); $('readerDockTheme').setAttribute('aria-expanded', String(open)); if (!open) $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onpointerover = e => { const option = e.target.closest('[data-reader-theme-option]'); if (option) $('readerModal').dataset.readerTheme = option.dataset.readerThemeOption; };
    themePicker.onpointerleave = () => { $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onfocusin = e => { const option = e.target.closest('[data-reader-theme-option]'); if (option) $('readerModal').dataset.readerTheme = option.dataset.readerThemeOption; };
    themePicker.onfocusout = e => { if (!themePicker.contains(e.relatedTarget)) $('readerModal').dataset.readerTheme = currentReaderStyle().theme || 'paper'; };
    themePicker.onclick = async e => { const option = e.target.closest('[data-reader-theme-option]'); if (!option) return; await updateReaderStyle('theme', option.dataset.readerThemeOption); closeThemePicker(); toast(`已应用“${option.dataset.themeName}”主题。`); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && themePicker.classList.contains('open')) closeThemePicker(); });
    $('readerDockSettings').onclick = () => $('readerSettings').classList.toggle('open');
    $('readerDockSpeak').onclick = toggleReaderSpeech;
    $('readerProgressRange').oninput = e => { const percent = Number(e.target.value) / 10; e.target.style.setProperty('--progress', `${percent}%`); renderSeekPreview(Number(e.target.value)); };
    $('readerProgressRange').onchange = e => renderSeekPreview(Number(e.target.value));
    $('readerSeekCancel').onclick = () => { state.pendingSeekValue = null; $('readerSeekPreview').classList.add('hidden'); updateReaderProgressUI(); };
    $('readerSeekConfirm').onclick = confirmProgressSeek;
    $('readerPositionBack').onclick = navigateReaderBack; $('readerPositionForward').onclick = navigateReaderForward;
    $('readerPositionHistoryToggle').onclick = () => { renderReaderPositionHistory(); $('readerPositionHistory').classList.toggle('open'); };
    $('readerPositionHistoryClose').onclick = () => $('readerPositionHistory').classList.remove('open');
    $('readerPositionHistoryItems').onclick = e => {
      const entryButton = e.target.closest('[data-position-entry]');
      if (entryButton) { const entryId = entryButton.dataset.positionEntry; queueReaderNavigation(async () => { const book = state.readerBook; if (!book) return; const entry = state.navigationService.export(book.id).entries.find(item => item.id === entryId); const target = state.navigationService.restoreEntry(book.id, entry, captureReaderAnchor()); if (target) { await restoreReaderAnchor(target); await persistReaderPosition(true); showReaderUndoNotice(entry?.sourceAnchor, target); renderReaderPositionHistory(); } }); return; }
      const sessionButton = e.target.closest('[data-session-start],[data-session-end]'); if (!sessionButton) return;
      const sessionId = sessionButton.dataset.sessionStart || sessionButton.dataset.sessionEnd, useStart = !!sessionButton.dataset.sessionStart;
      queueReaderNavigation(async () => {
        const book = state.readerBook; if (!book) return;
        const session = state.navigationService.export(book.id).sessions.find(item => item.id === sessionId), target = useStart ? session?.startAnchor : session?.endAnchor;
        if (target) { const from = captureReaderAnchor(); state.navigationService.restoreEntry(book.id, { targetAnchor: target }, from); await restoreReaderAnchor(target); await persistReaderPosition(true); showReaderUndoNotice(from, target); renderReaderPositionHistory(); }
      });
    };
    $('readerProgressPrev').onclick = () => moveReaderPage(-1);
    $('readerProgressNext').onclick = () => moveReaderPage(1);
    $('readerPrev').onclick = () => { if (state.readerChapterIndex > 0) { animateReaderTurn(-1); renderChapter(state.readerChapterIndex - 1); persistReaderPosition(); } };
    $('readerNext').onclick = () => { if (state.readerChapterIndex < state.readerChapters.length - 1) { animateReaderTurn(1); renderChapter(state.readerChapterIndex + 1); persistReaderPosition(); } };
    $('readerTocItems').onclick = e => {
      const item = e.target.closest('[data-chapter-index]'); if (!item) return;
      const target = Number(item.dataset.chapterIndex), chapter = state.readerChapters[target]; if (!chapter) return;
      animateReaderTurn(target >= state.readerChapterIndex ? 1 : -1);
      navigateReaderToAnchor({ fileHash: state.readerBook?.hash || '', chapterId: chapter.id, chapterIndex: target, chapterTitle: chapter.title, blockIndex: 0, charOffset: 0, sourceOffset: chapter.blocks?.find(block => Number.isFinite(block.sourceOffset))?.sourceOffset ?? null, chapterScrollRatio: 0, progress: target / Math.max(1, state.readerChapters.length) * 100 }, '目录');
    };
    $('fontDown').onclick = () => updateReaderStyle('fontSize', Math.max(14, Number(currentReaderStyle().fontSize) - 1));
    $('fontUp').onclick = () => updateReaderStyle('fontSize', Math.min(30, Number(currentReaderStyle().fontSize) + 1));
  }


  return { applyReaderStyle, reflowReaderPreservingPosition, installReaderControls, moveReaderPage, toggleReaderFullscreen, showReaderImage, persistReaderPosition, navigateReaderBack, navigateReaderForward, openBook, closeReader, bindReaderEvents };
}
