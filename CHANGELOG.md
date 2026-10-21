# Changelog · 更新日志

记录 Yomi Reader 的用户可见改动、兼容性及已知限制。版本遵循语义化版本，当前仍为预览软件。

## [0.3.0] - 2026-10-22

### 新增
- Windows 和 Android 共用的**离线阅读字体库**：20 款经授权的字体风格（19 款含中文字符），类别筛选、字体预览、按书设置、全局默认字体。
- 支持导入并保存 TTF、OTF、WOFF、WOFF2 自定义字体；格式文件头校验、16 MB 单文件限制、同内容去重、删除与缺失字体安全回退。
- Android 安装图标直接使用 Windows 端原创 `assets/yomi-reader.png`；统一图标素材，不使用 Capacitor 默认图案。
- Windows x64 安装程序及 Android ARM64 APK 均纳入 GitHub Actions 构建产物。
- 阅读器首次启动引导、使用帮助、重新体验教程入口。

### 改进
- Android：沉浸式阅读、状态栏隐藏选项、音量键翻页、轻点左右翻页、中心轻点隐藏/恢复工具栏。
- Windows：键盘箭头、空格、PageUp/PageDown、Esc、F11 操作。
- 两端：EPUB/TXT/PDF 多文件导入，文件夹递归扫描、格式筛选、全选/取消全选、批量导入进度和 SHA-256 默认去重。
- 拆分应用入口、阅读控制器、数据库、书库、统计、下载任务与样式，保留一份跨平台核心。
- Windows 单实例启动保护，避免多个 Electron 实例争用缓存。
- Android 构建版本号与项目版本统一；预置字体在构建时校验来源、大小及 SHA-256 并保留许可证。
- 本机 IndexedDB 从 v3 升级到 v4，仅新增 `customFonts` 表，不清空书库、笔记或阅读进度。

### 已知限制
- 两个平台暂不提供自动书库同步；不同设备的数据分别保存在本机。
- Android 测试包使用 debug 签名，版本间可能需要相同签名才能覆盖升级；不要在未备份前卸载已有应用。
- 手机端文件夹选择受 Android 系统文件提供商权限控制；单个 EPUB/PDF/TXT 读取上限为 128 MB。
- Android PDF 使用滚动预览，精细化进度跳转历史仍主要适用于 EPUB/TXT。
- 字体包采用 GB2312/常用字子集，罕见汉字及某些西文字体不支持的字形将回退系统字体。
- 尚需不同安卓厂商、屏幕比例、特大书籍的真机回归。

## [0.2.3] - 2026-10
- Windows 本地轻小说阅读器预览版。
- EPUB/TXT/PDF 导入、图书馆、目录、阅读主题和进度历史基础能力。

[0.3.0]: https://github.com/change7488/yomi-reader/compare/v0.2.3...main
[0.2.3]: https://github.com/change7488/yomi-reader/releases/tag/v0.2.3
