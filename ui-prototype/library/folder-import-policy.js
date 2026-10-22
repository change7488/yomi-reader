// Keep directory scans and import previews bounded on low-memory Android devices.
// The full selected state lives in the existing library model, not in the DOM.
export const PREVIEW_PAGE_SIZE = 60;
export const ANDROID_MAX_FILES_PER_BATCH = 16;
export const WINDOWS_MAX_FILES_PER_BATCH = 50;
export const ANDROID_MAX_BATCH_BYTES = 80 * 1024 * 1024;
export const WINDOWS_MAX_BATCH_BYTES = 512 * 1024 * 1024;

export function visibleImportItems(items, count = PREVIEW_PAGE_SIZE) {
  return items.slice(0, Math.max(0, Math.floor(count)));
}

export function planImportBatch(items, isAndroid = false) {
  const maxFiles = isAndroid ? ANDROID_MAX_FILES_PER_BATCH : WINDOWS_MAX_FILES_PER_BATCH;
  const maxBytes = isAndroid ? ANDROID_MAX_BATCH_BYTES : WINDOWS_MAX_BATCH_BYTES;
  const batch = [];
  let plannedBytes = 0;
  let totalSelected = 0;
  for (const item of items) {
    if (!item.selected) continue;
    totalSelected++;
    if (batch.length >= maxFiles) continue;
    const bytes = Math.max(0, Number(item.size) || 0);
    // Always consider at least the first book; invalid/oversized files are rejected individually.
    if (batch.length && plannedBytes + bytes > maxBytes) continue;
    batch.push(item);
    plannedBytes += bytes;
  }
  return { batch, remaining: totalSelected - batch.length, totalSelected, plannedBytes };
}
