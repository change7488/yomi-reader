<div align="center">
  <img src="assets/yomi-reader.png" alt="Yomi Reader 图标：黑发少女阅读青绿色书籍" width="144" />
  <h1>Yomi Reader</h1>
  <p>为轻小说爱好者打造的 Windows / Android 离线阅读器</p>
</div>

一个共用 HTML/CSS/JavaScript 阅读核心的离线轻小说阅读器。Windows 使用 Electron 桌面壳，Android ARM64 使用 Capacitor。书库、EPUB/TXT 解析、阅读进度和主题代码共用，平台特有能力放在独立适配层。项目仍处于预览阶段。

## 界面预览

首页展示继续阅读进度、书库概览与近期阅读统计；书库支持封面网格、列表和封面大小调整。截图使用虚构的演示书籍，不含个人书库内容。

![Yomi Reader 首页](screenshots/home.png)

![Yomi Reader 本地图书馆](screenshots/library.png)

## 下载 Windows 预览版

前往 [GitHub Releases](https://github.com/change7488/yomi-reader/releases) 查看版本；当前 Windows x64 预览版为 v0.2.3：

[下载 Yomi Reader v0.2.3 Windows 安装程序](https://github.com/change7488/yomi-reader/releases/download/v0.2.3/Yomi-Reader-0.2.3-x64-Setup.exe)

运行安装程序并按提示完成安装。预览版面向 Windows x64；尚未进行代码签名，Windows 可能显示发布者验证提示。

## Android ARM64 测试版

Android APK 由 GitHub Actions 自动编译。打开仓库的 [Actions](https://github.com/change7488/yomi-reader/actions/workflows/android-apk.yml)，选择成功的 **Android ARM64 APK** 构建，在底部的 **Artifacts** 下载 `Yomi-Reader-Android-arm64-debug`，解压获得 APK。

这是适用于 ARM64 Android（Android 7.0+）的**测试版**，使用 debug 签名，不代表已经进行全部设备兼容性测试。手机端提供底部导航、手势翻页、本地导入与 PDF.js 离线预览；目前不支持 Windows 独有的磁盘管理和文件夹下载监控。两个平台不会自动同步书库。

有 Android Studio / Android SDK 36、JDK 21、Node.js 22 的开发者可在仓库根目录运行：

```powershell
npm ci
npm run android:apk
```

生成路径：`release/Yomi-Reader-Android-arm64-debug.apk`。正式发布前需要配置独立的 release 签名。

## 运行桌面版

需要 Node.js 和 npm。在仓库根目录运行：

```powershell
npm ci
npm start
```

或双击 `启动LibraReader.bat`。应用程序内部沿用早期的 `Libra Reader` 数据目录标识，以便延续本机已有数据；界面名称为 Yomi Reader。

## 已实现

- 导入 EPUB、PDF、TXT，复制图书到软件管理目录，并按文件哈希检查重复。
- 本地图书馆、搜索、筛选、网格与列表视图、封面大小调整、收藏和虚拟文件夹。
- TXT 章节识别、EPUB 目录与插图浏览、阅读排版与主题设置。
- 阅读位置自动保存、跳转历史、误跳转返回，以及本机阅读统计。
- 三套界面配色、浅色／深色／跟随系统模式、自定义强调色。

部分高级阅读和书库管理功能仍在开发中。PDF 阅读依赖 Electron 内置预览能力。网页预览与桌面版的文件存储方式不同；请在桌面版中检查实际使用的数据。

## 测试

```powershell
npm test
npm run test:ui
```

`test:ui` 使用临时配置目录进行界面冒烟测试，不会修改正常使用的书库。构建安装包可运行 `npm run dist:win`。

## 仓库结构

- `electron/`：Windows 桌面壳、本地文件存储和测试。
- `ui-prototype/reader/`：Windows / Android 共用的阅读器控制器、格式解析与进度模块。
- `ui-prototype/platform/`：Android 手机布局、手势交互与 PDF 适配。
- `docs/DEVELOPMENT.md`：代码分层、Android 构建和开发规范。
- `ui-prototype/`：阅读器界面、书库逻辑、阅读解析与测试。
- `app.py`、`core.py`：早期 Python BookBridge 实验版，和当前桌面阅读器分开运行。

用户导入的图书、阅读记录、账号信息及构建产物不属于源码，不应提交到仓库。本项目不附带任何受版权保护的书籍。

## 许可证

源码以 [MIT License](LICENSE) 发布。第三方依赖各自遵循其许可证。
