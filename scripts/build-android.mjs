// One command for contributors to create an Android ARM64 debug APK.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.');
const win = process.platform === 'win32';
const nativeRoot = resolve('mobile');
const command = win ? 'cmd.exe' : 'sh';
function run(label, program, args, cwd = root) {
  console.log('> ' + label);
  const job = spawnSync(program, args, { cwd, stdio: 'inherit', shell: false });
  if (job.error || job.status !== 0) throw new Error(label + ' 失败。检查 Node 22、JDK 21、Android SDK 36 配置。');
}
function npmRun(args) {
  if (win) run('npm ' + args.join(' '), 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]);
  else run('npm ' + args.join(' '), 'npm', args);
}
function cap(args) {
  if (win) run('npx cap ' + args.join(' '), 'cmd.exe', ['/d','/s','/c','npx','cap',...args], nativeRoot);
  else run('npx cap ' + args.join(' '), 'npx', ['cap',...args], nativeRoot);
}
if (!existsSync(resolve('mobile/node_modules/@capacitor/android/package.json')) || !existsSync(resolve('mobile/node_modules/pdfjs-dist/build/pdf.mjs'))) {
  npmRun(['run', 'android:deps']);
}
run('准备共享网页资源', process.execPath, ['scripts/prepare-android.mjs']);
if (!existsSync(resolve('mobile/android/gradlew')) && !existsSync(resolve('mobile/android/gradlew.bat'))) cap(['add','android']);
cap(['sync','android']);
run('设置 ARM64 构建参数', process.execPath, ['scripts/configure-android.mjs']);
if (win) run('Gradle assembleDebug', command, ['/d','/s','/c','gradlew.bat','assembleDebug','--no-daemon'], resolve('mobile/android'));
else run('Gradle assembleDebug', command, ['gradlew','assembleDebug','--no-daemon'], resolve('android'));
const from = resolve('mobile/android/app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(from)) throw new Error('Gradle 返回成功，但找不到输出 APK：' + from);
mkdirSync(resolve('release'), { recursive: true });
const dest = resolve('release/Yomi-Reader-Android-arm64-debug.apk');
copyFileSync(from, dest);
console.log('\nAPK 已生成：' + dest);
