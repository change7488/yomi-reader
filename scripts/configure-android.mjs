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
console.log('Android ABI: arm64-v8a');

// Add the tiny native key plugin after Capacitor regenerates Android files.
import { copyFileSync, mkdirSync } from 'node:fs';
const nativeFolder = resolve('mobile/android/app/src/main/java/com/change7488/yomireader');
mkdirSync(nativeFolder, { recursive: true });
for (const name of ['MainActivity.java', 'ReaderKeysPlugin.java', 'ReaderFilesPlugin.java']) {
  copyFileSync(resolve('mobile/native', name), resolve(nativeFolder, name));
}
console.log('Android ReaderKeys bridge installed');
