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
