// On Android render PDF locally: native WebView does not embed PDF blobs reliably.
export async function renderMobilePdf({ stage, file }) {
  const pdfjs = await import(new URL('../vendor/pdfjs/pdf.mjs', import.meta.url).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await task.promise;
  stage.replaceChildren();
  stage.classList.add('yomi-mobile-pdf');
  const gallery = globalThis.document.createElement('div');
  gallery.className = 'yomi-pdf-pages';
  gallery.setAttribute('aria-label', `PDF，共 ${document.numPages} 页`);
  stage.appendChild(gallery);
  const firstPage = await document.getPage(1);
  const firstView = firstPage.getViewport({ scale: 1 });
  const pageWidth = Math.max(240, Math.min(900, stage.clientWidth - 24));
  const pageHeight = Math.round(firstView.height * pageWidth / firstView.width);
  const pages = new Map();
  const busy = new Set();
  let closed = false;
  for (let index = 1; index <= document.numPages; index++) {
    const holder = globalThis.document.createElement('section');
    holder.className = 'yomi-pdf-page';
    holder.dataset.page = String(index);
    holder.style.minHeight = pageHeight + 'px';
    const number = globalThis.document.createElement('small');
    number.textContent = `${index} / ${document.numPages}`;
    holder.append(number);
    gallery.append(holder);
    pages.set(index, holder);
  }
  async function draw(index) {
    const holder = pages.get(index);
    if (closed || !holder || busy.has(index) || holder.querySelector('canvas')) return;
    busy.add(index);
    try {
      const page = index === 1 ? firstPage : await document.getPage(index);
      const natural = page.getViewport({ scale: 1 });
      const scale = pageWidth / natural.width;
      const viewport = page.getViewport({ scale: scale * Math.min(2, devicePixelRatio || 1) });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = pageWidth + 'px';
      canvas.style.height = Math.floor(natural.height * scale) + 'px';
      if (closed) return;
      holder.style.minHeight = canvas.style.height;
      holder.prepend(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
      if (closed) canvas.remove();
    } catch (error) {
      if (!closed) { const p = globalThis.document.createElement('p'); p.textContent = 'PDF 页面渲染失败：' + (error?.message || error); holder.append(p); }
    } finally { busy.delete(index); }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const index = Number(entry.target.dataset.page);
      if (entry.isIntersecting) void draw(index);
      else if (!busy.has(index)) entry.target.querySelector('canvas')?.remove();
    }
  }, { root: stage, rootMargin: '400px 0px' });
  for (const holder of pages.values()) observer.observe(holder);
  void draw(1);
  return () => { closed = true; observer.disconnect(); void task.destroy(); stage.classList.remove('yomi-mobile-pdf'); };
}
