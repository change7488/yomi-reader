import test from 'node:test';
import assert from 'node:assert/strict';
import { capPdfScale, PDF_MAX_ACTIVE_CANVASES, PDF_MAX_CANVAS_PIXELS, PDF_QUALITY } from './pdf-viewer.js';

test('PDF quality presets stay below the requested canvas pixel budget', () => {
  for (const quality of Object.values(PDF_QUALITY)) {
    const scale = capPdfScale(2400, 3400, quality * 1.5, PDF_MAX_CANVAS_PIXELS);
    assert.ok(2400 * 3400 * scale ** 2 <= PDF_MAX_CANVAS_PIXELS + 1);
  }
});

test('PDF scale cap handles invalid sizes and never returns an unbounded scale', () => {
  assert.equal(capPdfScale(0, -1, 99, 100), 10);
  assert.ok(capPdfScale(500, 500, 3, 1_000_000) <= 2);
  assert.equal(PDF_MAX_ACTIVE_CANVASES, 5);
});
