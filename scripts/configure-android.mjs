// Restrict optional native libraries to ARM64. The output is one installable APK.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const file = resolve('mobile/android/app/build.gradle');
if (!existsSync(file)) throw new Error('先运行 npm run android:apk 创建工程');
let text = readFileSync(file, 'utf8');
const block = "        ndk { abiFilters 'arm64-v8a' }\n";
if (!text.includes("abiFilters 'arm64-v8a'")) {
  if (!text.includes('defaultConfig {')) throw new Error('Gradle 模板找不到 defaultConfig，检查 Capacitor 版本');
  text = text.replace('defaultConfig {', 'defaultConfig {\n' + block);
  writeFileSync(file, text);
}
const appVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error('Invalid package version');
text = readFileSync(file, 'utf8')
  .replace(/versionCode\s+\d+/, 'versionCode 31')
  .replace(/versionName\s+["'][^"']+["']/, 'versionName "' + appVersion + '"');
writeFileSync(file, text);
console.log('Android ABI: arm64-v8a, versionName ' + appVersion);

// Add the tiny native key plugin after Capacitor regenerates Android files.
import { copyFileSync, mkdirSync } from 'node:fs';
const nativeFolder = resolve('mobile/android/app/src/main/java/com/change7488/yomireader');
mkdirSync(nativeFolder, { recursive: true });
for (const name of ['MainActivity.java', 'ReaderKeysPlugin.java', 'ReaderFilesPlugin.java']) {
  copyFileSync(resolve('mobile/native', name), resolve(nativeFolder, name));
}
console.log('Android ReaderKeys bridge installed');

// Use the exact same artwork as the Windows .ico, not a generated Capacitor launcher.
const iconSource = resolve('assets/yomi-reader.png');
if (!existsSync(iconSource)) throw new Error('缺少 Windows 共用图标：assets/yomi-reader.png');
const iconFolder = resolve('mobile/android/app/src/main/res/drawable-nodpi');
mkdirSync(iconFolder, { recursive: true });
copyFileSync(iconSource, resolve(iconFolder, 'yomi_launcher.png'));
const manifestPath = resolve('mobile/android/app/src/main/AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');
for (const attr of ['icon', 'roundIcon']) {
  const pattern = new RegExp('android:' + attr + '="[^"]+"');
  if (!pattern.test(manifest)) throw new Error('AndroidManifest.xml 未找到 ' + attr + ' 配置');
  manifest = manifest.replace(pattern, 'android:' + attr + '="@drawable/yomi_launcher"');
}
writeFileSync(manifestPath, manifest);
console.log('Android 桌面图标已统一为 assets/yomi-reader.png');
