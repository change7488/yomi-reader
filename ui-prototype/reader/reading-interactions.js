// Shared, touch-safe reading gestures for Electron and Android.
// The reading surface handles taps; panels, links, images and selections retain their behavior.
export function tapRegion(x, width) {
  if (!Number.isFinite(x) || !(width > 0)) return 'center';
  const ratio = x / width;
  return ratio < 0.28 ? 'previous' : ratio > 0.72 ? 'next' : 'center';
}

export function pageDirectionForKey(key, shift = false) {
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown') return 1;
  if (key === ' ' || key === 'Spacebar') return shift ? -1 : 1;
  return 0;
}

export function installReadingSurface({ modal, body, canTurnPage, movePage, markActivity, mobile }) {
  let gesture = null;
  const ignored = 'button, input, textarea, select, a, [contenteditable], [data-reader-image], iframe, canvas, .reader-lightbox, .yomi-guide-layer';
  const onDown = event => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest(ignored)) { gesture = null; return; }
    gesture = { x: event.clientX, y: event.clientY, time: Date.now(), id: event.pointerId };
  };
  const onCancel = () => { gesture = null; };
  const onUp = event => {
    const start = gesture; gesture = null;
    if (!start || !event.isPrimary || event.pointerId !== start.id || event.target.closest(ignored)) return;
    if (Math.abs(start.x - event.clientX) > 14 || Math.abs(start.y - event.clientY) > 14 || Date.now() - start.time > 550) return;
    if (!modal.isConnected || modal.classList.contains('hidden')) return;
    if (window.getSelection()?.toString().trim()) return;
    if (modal.querySelector('.reader-lightbox.open, .reader-toc.open, .reader-settings.open, .reader-gallery.open, .reader-bookmarks.open, .reader-notes-panel.open, .reader-search-panel.open, .reader-position-history.open')) return;
    if (document.querySelector('.yomi-guide-layer')) return;
    markActivity();
    const rect = body.getBoundingClientRect();
    const action = tapRegion(event.clientX - rect.left, rect.width);
    if (action === 'center') modal.classList.toggle('reader-ui-hidden');
    else if (canTurnPage()) movePage(action === 'next' ? 1 : -1);
    else if (mobile) modal.classList.toggle('reader-ui-hidden');
  };
  body.addEventListener('pointerdown', onDown, { passive: true });
  body.addEventListener('pointerup', onUp, { passive: true });
  body.addEventListener('pointercancel', onCancel);
  body.addEventListener('scroll', onCancel, true);
  return () => {
    body.removeEventListener('pointerdown', onDown);
    body.removeEventListener('pointerup', onUp);
    body.removeEventListener('pointercancel', onCancel);
    body.removeEventListener('scroll', onCancel, true);
  };
}
