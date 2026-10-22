// Copy the pinned PDF.js runtime into the shared UI assets used by Electron
// and Capacitor. The source dependency is declared by the desktop project so
// Windows packaging does not depend on an Android-only install step.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = join(root, 'node_modules', 'pdfjs-dist', 'build');
const target = join(root, 'ui-prototype', 'vendor', 'pdfjs');
const files = ['pdf.mjs', 'pdf.worker.mjs'];

for (const file of files) {
  if (!existsSync(join(source, file))) {
    throw new Error(`缺少 PDF.js 文件：${join(source, file)}。请先运行 npm install。`);
  }
}

mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));
console.log('PDF.js 共享阅读资源已同步：ui-prototype/vendor/pdfjs');
