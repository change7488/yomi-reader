// Shared PDF.js viewer for Windows and Android. Canvas work is limited to the
// visible neighborhood and every quality preset is constrained by a pixel cap.
export const PDF_QUALITY = Object.freeze({ auto: 1.35, standard: 1, hd: 1.5, ultra: 2 });
export const PDF_MAX_CANVAS_PIXELS = 12_000_000;
export const PDF_MAX_ACTIVE_CANVASES = 5;

export function capPdfScale(width, height, requestedScale, pixelBudget = PDF_MAX_CANVAS_PIXELS) {
  const safeWidth = Math.max(1, Number(width) || 1), safeHeight = Math.max(1, Number(height) || 1);
  const safeScale = Math.max(.25, Number(requestedScale) || 1);
  return Math.min(safeScale, Math.sqrt(Math.max(1, pixelBudget) / (safeWidth * safeHeight)));
}

export async function renderPdfViewer({ stage, file, settings = {}, onProgress = () => {}, onState = () => {}, pixelBudget = PDF_MAX_CANVAS_PIXELS }) {
  const pdfjs = await import(new URL('../vendor/pdfjs/pdf.mjs', import.meta.url).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await task.promise;
  let opts = { mode: 'document', direction: 'ltr', quality: 'auto', fit: 'width', zoom: 1, gap: 'standard', coverAlone: true, ...settings };
  const mobile = globalThis.matchMedia?.('(pointer:coarse)').matches || false;
  const budget = Math.min(pixelBudget, mobile ? 8_000_000 : PDF_MAX_CANVAS_PIXELS);
  const pages = new Map();
  const tasks = new Map();
  const rendered = new Map();
  const thumbnails = new Map();
  const thumbnailTasks = new Set();
  const busy = new Set();
  const visibleCandidates = new Set();
  let closed = false;
  let currentPage = Math.max(1, Math.min(document.numPages, Number(settings.page) || 1));
  let undoPage = null, redoPage = null;
  let lastReportedPage = 0;
  let resizeTimer = 0;
  const continuous = () => opts.mode === 'document' || opts.mode === 'scroll';

  stage.replaceChildren();
  stage.classList.add('yomi-pdf-stage');
  stage.classList.toggle('yomi-pdf-continuous', continuous());
  const gallery = globalThis.document.createElement('div');
  gallery.className = 'yomi-pdf-pages';
  gallery.setAttribute('aria-label', `PDF，共 ${document.numPages} 页`);
  stage.appendChild(gallery);

  const firstPage = await document.getPage(1);
  const firstView = firstPage.getViewport({ scale: 1 });
  function fitWidth(page) {
    const viewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(240, (stage.clientWidth - 32) / (opts.mode === 'double' ? 2 : 1));
    const availableHeight = Math.max(240, stage.clientHeight - 32);
    let scale = opts.fit === 'original' ? 1 : opts.fit === 'screen' ? Math.min(availableWidth / viewport.width, availableHeight / viewport.height) : availableWidth / viewport.width;
    return scale * Math.max(.5, Math.min(3, Number(opts.zoom) || 1));
  }
  function spacing() { return ({ none: 0, compact: 4, standard: 16 })[opts.gap] ?? 16; }
  for (let index = 1; index <= document.numPages; index++) {
    const holder = globalThis.document.createElement('section');
    holder.className = 'yomi-pdf-page'; holder.dataset.page = String(index);
    holder.style.minHeight = `${Math.round(firstView.height * Math.max(.25, Math.min(1.4, (stage.clientWidth - 32) / firstView.width)))}px`;
    holder.style.marginBlockEnd = `${spacing()}px`;
    const number = globalThis.document.createElement('small'); number.textContent = `${index} / ${document.numPages}`; holder.append(number);
    gallery.append(holder); pages.set(index, holder);
  }

  function visiblePages() {
    if (continuous()) return null;
    if (opts.mode === 'double') {
      if (opts.coverAlone && currentPage === 1) return [1];
      const spread = Math.max(0, Math.floor((currentPage - (opts.coverAlone ? 2 : 1)) / 2));
      const first = (opts.coverAlone ? 2 : 1) + spread * 2;
      const pair = [first, first + 1].filter(page => page <= document.numPages);
      return opts.direction === 'rtl' ? pair.reverse() : pair;
    }
    return [currentPage];
  }
  function updateLayout() {
    const selected = visiblePages();
    stage.classList.toggle('yomi-pdf-continuous', continuous());
    stage.classList.toggle('is-zoomed', Number(opts.zoom) > 1.01);
    gallery.classList.toggle('yomi-pdf-spread', opts.mode === 'double');
    gallery.classList.toggle('yomi-pdf-single', opts.mode === 'single');
    for (const [index, holder] of pages) {
      const visible = !selected || selected.includes(index);
      holder.classList.toggle('is-current-page', visible && (!selected || index === currentPage || selected[0] === index));
      holder.hidden = !visible;
    }
    onState({ page: currentPage, pageCount: document.numPages, progress: currentPage / document.numPages, canUndo: undoPage !== null, canRedo: redoPage !== null, settings: { ...opts } });
    if (selected) { for (const page of selected) void draw(page); void draw(currentPage + 1); }
  }
  async function draw(index) {
    const holder = pages.get(index);
    if (closed || !holder || holder.hidden || busy.has(index)) return;
    const old = rendered.get(index);
    if (old) { old.usedAt = Date.now(); return; }
    busy.add(index);
    try {
      const page = index === 1 ? firstPage : await document.getPage(index);
      if (closed || holder.hidden) return;
      const natural = page.getViewport({ scale: 1 });
      const cssScale = fitWidth(page);
      const quality = PDF_QUALITY[opts.quality] || PDF_QUALITY.auto;
      const dpr = Math.min(1.5, globalThis.devicePixelRatio || 1);
      const simultaneousPages = opts.mode === 'double' ? 3 : PDF_MAX_ACTIVE_CANVASES;
      const pageBudget = Math.max(250_000, Math.floor(budget / simultaneousPages));
      const scale = capPdfScale(natural.width * cssScale, natural.height * cssScale, quality * dpr, pageBudget);
      const viewport = page.getViewport({ scale: cssScale * scale });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(natural.width * cssScale)}px`;
      canvas.style.height = `${Math.floor(natural.height * cssScale)}px`;
      holder.style.minHeight = canvas.style.height;
      const canvasContext = canvas.getContext('2d', { alpha: false });
      const renderTask = page.render({ canvasContext, viewport, canvas });
      tasks.set(index, renderTask);
      await renderTask.promise;
      tasks.delete(index);
      if (closed || holder.hidden) { releaseCanvas(index, canvas); return; }
      holder.prepend(canvas); rendered.set(index, { canvas, page, usedAt: Date.now() });
      evictCanvases(index);
    } catch (error) {
      tasks.delete(index);
      if (!closed && error?.name !== 'RenderingCancelledException' && !holder.querySelector('.yomi-pdf-error')) {
        const message = globalThis.document.createElement('small'); message.className = 'yomi-pdf-error'; message.textContent = `页面渲染失败：${error?.message || error}`; holder.append(message);
      }
    } finally {
      busy.delete(index);
      if (!closed && visibleCandidates.has(index) && !rendered.has(index) && !holder.querySelector('.yomi-pdf-error')) void draw(index);
    }
  }
  function releaseCanvas(index, canvas = rendered.get(index)?.canvas) {
    if (!canvas) return;
    canvas.width = 0; canvas.height = 0; canvas.remove();
    const entry = rendered.get(index); if (entry?.canvas === canvas) rendered.delete(index);
  }
  function evictCanvases(keep) {
    const current = visiblePages() || [];
    const protectedPages = new Set([...current, currentPage - 1, currentPage + 1, keep]);
    const entries = [...rendered.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
    while (rendered.size > PDF_MAX_ACTIVE_CANVASES) {
      const [index, entry] = entries.find(([page]) => !protectedPages.has(page)) || entries[0];
      if (!entry) break;
      releaseCanvas(index, entry.canvas);
      const position = entries.findIndex(([page]) => page === index); if (position >= 0) entries.splice(position, 1);
    }
  }
  function reportPage(page) {
    currentPage = Math.max(1, Math.min(document.numPages, Math.round(page)));
    if (lastReportedPage !== currentPage) { lastReportedPage = currentPage; onProgress({ page: currentPage, pageCount: document.numPages, progress: currentPage / document.numPages }); }
    if (!continuous()) updateLayout();
  }
  const observer = new IntersectionObserver(entries => {
    let best = null;
    for (const entry of entries) {
      const index = Number(entry.target.dataset.page);
      if (entry.isIntersecting) { visibleCandidates.add(index); void draw(index); if (!best || entry.intersectionRatio > best.intersectionRatio) best = { index, intersectionRatio: entry.intersectionRatio }; }
      else {
        visibleCandidates.delete(index);
        if (continuous() || entry.target.hidden) {
          try { tasks.get(index)?.cancel(); } catch { /* task already completed */ }
          if (!busy.has(index)) releaseCanvas(index);
        }
      }
    }
    if (best && continuous()) reportPage(best.index);
  }, { root: stage, rootMargin: '500px 0px', threshold: [0, .15, .4, .7, 1] });
  for (const holder of pages.values()) observer.observe(holder);
  function setSettings(next = {}) {
    opts = { ...opts, ...next };
    if (!['document', 'scroll', 'single', 'double'].includes(opts.mode)) opts.mode = 'document';
    if (!['ltr', 'rtl', 'ttb'].includes(opts.direction)) opts.direction = 'ltr';
    if (!Object.hasOwn(PDF_QUALITY, opts.quality)) opts.quality = 'auto';
    if (!['width', 'screen', 'original'].includes(opts.fit)) opts.fit = 'width';
    opts.zoom = Math.max(.5, Math.min(3, Number(opts.zoom) || 1));
    if (!['none', 'compact', 'standard'].includes(opts.gap)) opts.gap = 'standard';
    for (const [index, entry] of rendered) { releaseCanvas(index, entry.canvas); }
    for (const holder of pages.values()) holder.querySelector('.yomi-pdf-error')?.remove();
    updateLayout();
  }
  function gotoPage(page, { record = true } = {}) {
    const before = currentPage;
    const target = Math.max(1, Math.min(document.numPages, Math.round(page)));
    if (record && target !== before) { undoPage = before; redoPage = null; }
    reportPage(page);
    if (continuous()) pages.get(currentPage)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    else updateLayout();
  }
  const onScroll = () => {
    if (!continuous()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { onProgress({ page: currentPage, pageCount: document.numPages, progress: currentPage / document.numPages, scrollRatio: stage.scrollTop / Math.max(1, stage.scrollHeight - stage.clientHeight) }); }, 350);
  };
  stage.addEventListener('scroll', onScroll, { passive: true });
  const touchPoints = new Map();
  let touchStart = null, pinchStart = null;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch') return;
    const point = { x: event.clientX, y: event.clientY }; touchPoints.set(event.pointerId, point);
    if (touchPoints.size === 1) touchStart = point;
    if (touchPoints.size === 2) { const [a, b] = [...touchPoints.values()]; pinchStart = { distance: distance(a, b), zoom: Number(opts.zoom) || 1 }; }
  }, { passive: true });
  stage.addEventListener('pointermove', event => {
    if (!touchPoints.has(event.pointerId)) return;
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touchPoints.size > 1) event.preventDefault();
  }, { passive: false });
  const finishTouch = event => {
    if (!touchPoints.has(event.pointerId)) return;
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchStart && touchPoints.size >= 2) {
      const [a, b] = [...touchPoints.values()]; const ratio = distance(a, b) / Math.max(1, pinchStart.distance);
      const zoom = Math.max(.5, Math.min(3, pinchStart.zoom * ratio)); pinchStart = null; touchStart = null;
      for (const id of [...touchPoints.keys()]) touchPoints.delete(id);
      if (ratio > 1.06 || ratio < .94) setSettings({ zoom });
      return;
    }
    touchPoints.delete(event.pointerId);
    if (!touchStart || continuous()) { touchStart = null; return; }
    const dx = event.clientX - touchStart.x, dy = event.clientY - touchStart.y; touchStart = null;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    const forward = opts.direction === 'rtl' ? dx > 0 : dx < 0;
    forward ? api.next() : api.previous();
  };
  stage.addEventListener('pointerup', finishTouch, { passive: true });
  stage.addEventListener('pointercancel', finishTouch, { passive: true });
  stage.addEventListener('dblclick', event => {
    if (continuous() || !event.target.closest('canvas')) return;
    setSettings({ zoom: Number(opts.zoom) > 1.01 ? 1 : 1.65 });
  });
  stage.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setSettings({ zoom: Math.max(.5, Math.min(3, (Number(opts.zoom) || 1) * (event.deltaY < 0 ? 1.1 : .9))) });
  }, { passive: false });
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { for (const [index, entry] of rendered) releaseCanvas(index, entry.canvas); updateLayout(); }, 180);
  });
  resizeObserver.observe(stage);
  setSettings(opts);
  void draw(currentPage);
  const api = {
    pageCount: document.numPages,
    getState: () => ({ page: currentPage, pageCount: document.numPages, progress: currentPage / document.numPages, settings: { ...opts } }),
    gotoPage,
    undo: () => { if (undoPage === null) return false; const target = undoPage; undoPage = null; redoPage = currentPage; gotoPage(target, { record: false }); updateLayout(); return true; },
    redo: () => { if (redoPage === null) return false; const target = redoPage; redoPage = null; undoPage = currentPage; gotoPage(target, { record: false }); updateLayout(); return true; },
    next: () => gotoPage(currentPage + (opts.mode === 'double' ? (opts.coverAlone && currentPage === 1 ? 1 : 2) : 1)),
    previous: () => gotoPage(currentPage - (opts.mode === 'double' ? (opts.coverAlone && currentPage <= 3 ? currentPage - 1 : 2) : 1)),
    setSettings,
    async thumbnail(pageNumber, maxWidth = 92) {
      const number = Math.max(1, Math.min(document.numPages, Math.floor(pageNumber)));
      const cached = thumbnails.get(number);
      if (cached) { cached.usedAt = Date.now(); return cached.url; }
      const page = number === 1 ? firstPage : await document.getPage(number);
      if (closed) return '';
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1, maxWidth / natural.width) });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
      const renderTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport, canvas });
      thumbnailTasks.add(renderTask);
      try {
        await renderTask.promise;
        if (closed) return '';
        const url = canvas.toDataURL('image/jpeg', .68);
        thumbnails.set(number, { url, usedAt: Date.now() });
        while (thumbnails.size > 12) {
          const oldest = [...thumbnails.entries()].sort((a,b) => a[1].usedAt - b[1].usedAt)[0];
          if (!oldest) break; thumbnails.delete(oldest[0]);
        }
        return url;
      } finally { thumbnailTasks.delete(renderTask); canvas.width = 0; canvas.height = 0; }
    }
  };
  return { ...api, cleanup: () => {
    closed = true; observer.disconnect(); resizeObserver.disconnect(); clearTimeout(resizeTimer); stage.removeEventListener('scroll', onScroll);
    for (const renderTask of tasks.values()) { try { renderTask.cancel(); } catch { /* already completed */ } }
    for (const renderTask of thumbnailTasks) { try { renderTask.cancel(); } catch { /* already completed */ } }
    for (const [index, entry] of rendered) releaseCanvas(index, entry.canvas);
    for (const holder of pages.values()) holder.replaceChildren();
    pages.clear(); rendered.clear(); tasks.clear(); busy.clear(); visibleCandidates.clear(); thumbnails.clear(); thumbnailTasks.clear(); gallery.remove();
    stage.classList.remove('yomi-pdf-stage', 'yomi-pdf-continuous', 'is-zoomed'); touchPoints.clear();
    void task.destroy();
  } };
}

// Kept as a compatibility export while callers migrate to the shared viewer.
export async function renderMobilePdf(options) {
  return (await renderPdfViewer(options)).cleanup;
}
