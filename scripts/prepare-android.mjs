// Assemble the very same web UI used by Electron into Capacitor's webDir.
// No duplicated Android reading logic, no bundler, no second front-end project.
import { cpSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = join(root, 'dist', 'android');
const pdf = join(root, 'node_modules', 'pdfjs-dist', 'build');
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  if (!existsSync(join(pdf, name))) {
    throw new Error('缺少离线 PDF 引擎。请先运行 npm run android:deps。');
  }
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(root, 'ui-prototype'), target, {
  recursive: true,
  filter: path => !/\.test\.mjs$|(^|[\\/])README\.md$/.test(path)
});
mkdirSync(join(target, 'vendor', 'pdfjs'), { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  copyFileSync(join(pdf, name), join(target, 'vendor', 'pdfjs', name));
}
console.log('Android 共享网页资源准备完成：dist/android');
