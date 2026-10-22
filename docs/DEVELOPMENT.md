# Yomi Reader · 跨端开发

本仓库只有 **一套阅读器核心**：`ui-prototype/` 内的 HTML/CSS/ES modules。Windows 用 Electron 显示它；Android 用 Capacitor WebView 显示同一份代码。无需维护第二份 UI 或引入 React/Flutter。

## 项目结构

```text
ui-prototype/
  app.js             启动和页面/阅读协调（逐步缩小）
  reader/            EPUB/TXT 解析、进度锚点和共享阅读控制器
  storage/           IndexedDB 表结构与持久化
  library/           书架列表、筛选和卡片
  home/              首页
  analytics/         阅读统计
  downloads/         下载队列视图
  onboarding/        新用户帮助
  platform/          Android 触摸、布局和 PDF 适配
  styles/            按功能划分的有序 CSS
electron/            Windows 原生文件管理与下载监控
mobile/              薄 Android Capacitor 外壳与独立原生依赖
scripts/             Android 网页打包和 Gradle 构建脚本
.github/workflows/   自动打包 APK
```

## Windows 开发

```powershell
npm ci
npm run check
npm run test:ui
npm start
```

Windows 仍用 `electron/main.cjs`，默认书库位置、IndexedDB 名称、Electron appId 均保持不变。重复启动会激活现有窗口，避免 Chromium 缓存被多实例争用。

## Android ARM64 APK

需要 Node.js 22+、JDK 21、Android SDK 36（Android Studio 或命令行工具）。

```powershell
npm ci
npm run android:apk
```

命令会安装 `mobile/package.json` 中固定版本的 Capacitor 8、Android App 插件及 PDF.js，复制共享网页资源到 `dist/android`，初始化/同步 `mobile/android` 工程并运行 Gradle。结果：

`release/Yomi-Reader-Android-arm64-debug.apk`

这是 **ARM64 Android 7.0+ 的测试 APK**，采用 Android 自动生成的 debug 签名。GitHub Actions 里也提供同样的可下载构建产物。上架商店或正式对外发布前必须配置独立 release keystore、签名流程和设备测试。请勿把签名密钥提交到 GitHub。

## 平台差异

| 功能 | Windows | Android |
|---|---|---|
| EPUB/TXT 阅读、收藏、书签、目录、进度与笔记 | 共用核心 | 共用核心 |
| PDF | Electron PDF 内置预览 | 本地 PDF.js 按需渲染 |
| 导入 | 单文件、批量扫描、下载监控 | Android 系统文件选择器 |
| 书籍存储 | 本地管理文件夹 + IndexedDB | 应用私有 IndexedDB |
| 导航 | 左侧导航、鼠标滚轮/键盘 | 底部标签、滑动翻页、返回键 |
| 同步 | 无 | 无 |

两个平台**不自动同步**个人书库。Android 应用的数据由系统沙盒保存，卸载可能删除本地进度；务必自行保留原始电子书文件。Android 暂不提供 Windows 的扫描整个目录、磁盘位置迁移和下载监控能力，不应在手机端展示无法使用的入口。

## 开发准则

1. 新增解析和状态逻辑优先放进 `ui-prototype/reader/`、`storage/` 或功能模块，**不要继续往 app.js 堆大函数**。
2. 平台区别只出现在 `platform/` 与 `electron/`，避免在每个页面增加分散的 if-else。
3. 兼容已有 IndexedDB 名称 `libra-reader-preview`、appId、进度锚点字段与 Electron userData。
4. CSS 放到 `styles/` 下，并按 `styles.css` 清单的顺序引入；Android 专属规则放到 `platform/mobile.css`。
5. 修改后执行 `npm run check`、`npm run test:ui`。APK 相关修改还需检查 GitHub Actions 构建和真实 arm64 设备操作。

## 当前限制

首次跨端集成尚需真实 Android 手机验证；大 PDF 文档性能、手势与系统返回键、不同厂商文件选择器都需要设备回归。测试 APK 不等于正式上线版本。

## 阅读操作

Android EPUB/TXT：轻点左 28% 后退、右 28% 前进、中心隐藏/显示上下工具栏；左右滑动继续支持。音量减键下一页、音量加键上一页，仅在阅读器打开时拦截；书架中音量键仍调节系统声音。PDF 保持原生滚动，不强制按 EPUB 的翻页方式切割 PDF。

Windows EPUB/TXT：方向键左/上上一页、右/下下一页；PageUp/PageDown、空格/Shift+空格翻页；H 隐藏/显示工具栏；Esc 先关闭打开的面板，再退出阅读器；F11 切换全屏，Ctrl+Shift+左右箭头仍用于位置撤销/前进。

## 文件导入、去重与隐私

- **Windows**：文件多选使用操作系统文件选择器；文件夹扫描由 `electron/library-storage.cjs` 递归读取路径（仅限用户选定的文件夹）。
- **Android**：`mobile/native/ReaderFilesPlugin.java` 通过 Android Storage Access Framework 的系统授权选择器选择多个文件或文件夹，不要求全盘存储权限。它在原生层递归读取文件名、格式及大小，仅在用户确定导入时逐本读取内容。
- **共用界面**：`ui-prototype/app.js` 的文件夹导入窗口统一负责格式筛选、最小大小、全选/取消全选、单本勾选、导入结果和内容 SHA-256 去重。
- 默认拒绝重复内容：再次选择已经入库的同一本书，不会再次生成书目或覆盖阅读进度；只在文件夹导入时手动勾选「允许重复导入」才创建额外书目。Windows 上同哈希的重复书目可能共用同一份管理文件，因此删除实际文件时会阻止删除仍被其他书目引用的文件。
- Android 原生桥接为了控制设备内存，对单个 EPUB/PDF/TXT 文件设置 **128 MB** 上限。文件夹提供商可能限制可选择的根目录，实际可用目录由系统决定。
- 手机阅读中默认进入沉浸模式，隐藏状态栏和导航栏；阅读器排版面板中可关闭「沉浸阅读」选项，退出阅读器后系统栏自动恢复。桌面端不使用 Android 原生状态栏功能。

新增平台能力只能加入 `platform/` 或 `mobile/native/`，不要在书籍格式解析器里直接调用原生存储 API。

## 字体系统 v0.3.0

字体功能只在共享前端中实现一次：

- `ui-prototype/fonts/catalog.json`：固定的 20 款 OFL 字体清单（包含来源、文件大小、SHA-256、中文覆盖数）。
- `ui-prototype/fonts/catalog.js`：前端 UI 使用的精简元数据。
- `ui-prototype/fonts/font-manager.js`：字体校验、从 IndexedDB 加载/保存、预览、选择、删除与回退。
- `ui-prototype/fonts/font-manager.css`：Windows/Android 共用排版控件与响应式字体卡片。
- `scripts/sync-fonts.mjs`：从固定版本字体仓库下载 20 款字体及授权；逐一校验 SHA-256，已经缓存时离线可运行，不将二进制提交 Git。
- `ui-prototype/fonts/builtin/`、`fonts/licenses/`：构建时生成的本地资源文件，均由 `.gitignore` 忽略，但会进入 Windows 安装包和 Android APK。
- `mobile/native/ReaderFilesPlugin.java`：Android 原生字体选择器（SAF），同样支持 EPUB/TXT/PDF 多文件导入，整个流程不要求广泛存储权限。

```powershell
npm ci
npm run fonts:sync           # 首次约下载 30 MiB 字体文件及许可证
npm run check                # 仅代码单测/语法，不依赖下载字体
npm start                    # 若字体缓存齐全，则无需联网
npm run dist:win             # 打包前自动同步字体
npm run android:apk          # 打包前自动同步字体 + Android 图标
```

**兼容性**：IndexedDB v3 → v4 增加 `customFonts` 表，保留所有原有书籍、阅读位置和收藏。用户导入字体仅保存在应用私有 IndexedDB，不被提交或上传。单字体 ≤16MiB，自定义最多 40 项；文件必须匹配 TTF、OTF、WOFF 或 WOFF2 的真实文件头。对较少见的汉字，官方字体子集无法覆盖时会回退系统字体。

**图标**：Windows 安装包使用 `assets/yomi-reader.ico`，Android 构建脚本将相同设计的 `assets/yomi-reader.png` 复制进 `mobile/android/app/src/main/res/drawable-nodpi/` 并配置 AndroidManifest `icon/roundIcon`。请不要再制作另一份 Android 默认图标。

**第三方许可**：20 款字体来自 <https://github.com/joeseesun/qiaomu-cover-fonts> v1.0.0，原字体设计者与许可详见 `catalog.json` 和下载后的 `fonts/licenses/*.txt`。修改字体来源时必须同步更新 SHA-256、许可证和版权说明。


**一致的应用品牌**：构建时将原版 `assets/yomi-reader.png` 同步到 `ui-prototype/assets/yomi-reader.png`，供 Windows 和 Android 首页共同引用；Android Launcher 图标则由 Gradle 配置脚本引用同一原图。SVG 旧占位图不再使用。

## v0.3.1 大文件夹与设备内存保护

Android SAF 文档提供者可能是本机存储、云盘或厂商文件管理器，其查询时间、目录大小和文件流实现差异很大。为避免后台查询触发 UI 线程阻塞和 Base64 传输时的大型瞬时内存副本，读取适配层采用：

- 原生目录 **广度优先** 扫描，最多 1,200 匹配文件、20,000 目录条目、18 层。结果截断时用户必须选择更小子目录，不暗中忽略限制。
- 系统文件夹元数据的读取放在原生单线程 executor 上；Native → JS 使用 128 KB 的 `openRead/readChunk/closeRead` 管道。文件流每次只打开一个，并在结束或失败时关闭。
- 单文件 64 MB 上限；此上限是预览版移动设备安全限制，不代表 EPUB/PDF 格式的理论最大值。
- 共享 UI 每次渲染最多 60 个文件项，通过“显示更多”逐页添加；一次导入 Android 最多 16 本、Windows 最多 50 本，可继续导入剩余选择项。
- `ui-prototype/library/folder-import-policy.js` 是批量限制的唯一来源，必须同步更新测试和 UI 显示。
- 流式读取仍需在 WebView 内组合成一个 File 供现有 EPUB 解析器使用；未来要支持超大文件需要进一步用原生应用文件仓库和增量解码替代 IndexedDB File。

本补丁不迁移或重建用户的任何数据库，Android 本地资料应当与旧版本处于同一应用沙盒。请注意 GitHub Actions 目前使用 debug 签名，不能保证跨构建无缝覆盖；不要在未备份书库前卸载旧 APK。

