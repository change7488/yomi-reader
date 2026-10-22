# Yomi Reader v0.3.0 · Windows / Android 双端预览版

Yomi Reader 迎来 Windows x64 与 Android ARM64 共用阅读核心的预览版。欢迎试用，遇到问题请在 [Issues](https://github.com/change7488/yomi-reader/issues) 提交反馈。

## 下载哪个？

- **Windows 11 / 10 x64**：`Yomi-Reader-0.3.0-x64-Setup.exe`（点击并按向导安装）。
- **Android 64 位手机**：`Yomi-Reader-Android-arm64-debug.apk`（测试签名；允许安装来自你选择来源的应用后安装）。
- **SHA256SUMS.txt**：校验安装包未在传输过程中损坏；Windows 可运行 `Get-FileHash -Algorithm SHA256 .\Yomi-Reader-0.3.0-x64-Setup.exe`。

## 主要变化

- **统一软件图标**：Android 桌面图标和 Windows 安装图标使用同一份 Yomi Reader 原创设计。
- **20 款离线阅读字体**：19 款包含中文字符，涵盖宋体、楷体、仿宋、黑体及个性字体。字体文件与 OFL 许可证已一同打包，不需要首次联网加载；支持 TTF、OTF、WOFF、WOFF2 本地导入、每本书选择及默认字体设置。
- **跨端导入**：EPUB/TXT/PDF 多选、文件夹递归筛选、全选/取消全选、默认跳过重复内容。Android 文件选择使用系统授权，不请求全盘存储权限。
- **沉浸阅读**：Android 支持音量键翻页、左右轻点翻页、中心轻点切换工具栏，以及隐藏系统状态栏；Windows 支持箭头键、空格、PageUp/PageDown、Esc 等快捷键。
- **阅读与管理**：新手引导、位置历史、书签、笔记、排版主题，统一工程结构。
- **数据兼容**：本地数据库升级仅增加字体数据表；不自动清除原书架、书签和阅读位置。Windows 沿用既有 Electron appId 与用户数据路径。

## 重要提醒

> **这是预览版，不是已正式签名的商业发行版。**

- Android 安装包为 CI 自动生成的 **debug APK**；不同构建可能具有不同签名。**不要为了安装新版而随意卸载已保存书库的旧版 APK**，卸载会清空应用内部书库和阅读记录。请先保存原始电子书，待后续提供正式备份迁移功能。
- Windows EXE 未使用商业代码签名，SmartScreen/杀毒软件可能提示“未知发布者”。请仅从本 GitHub Release 获取安装文件并核对 SHA256。
- Windows 和 Android 暂不自动同步书库及进度，且 Android 文件提供商可能对某些目录限制授权；PDF 高级跳转位置历史也尚未与 EPUB/TXT 等同。
- 大型字体或 EPUB、PDF 以及不同 Android 厂商机型仍需更多真实设备兼容性验证。

完整变更见 [CHANGELOG.md](https://github.com/change7488/yomi-reader/blob/main/CHANGELOG.md)，开发说明见 [docs/DEVELOPMENT.md](https://github.com/change7488/yomi-reader/blob/main/docs/DEVELOPMENT.md)。
