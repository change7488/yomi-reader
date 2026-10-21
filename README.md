# Yomi Reader

一个面向 Windows 的本地轻小说阅读器。当前桌面版使用 Electron、HTML、CSS 和 JavaScript；仓库还保留了早期的 Python BookBridge 实验代码。项目仍处于预览阶段。

## 运行桌面版

需要 Node.js 和 npm。在仓库根目录运行：

```powershell
npm ci
npm start
```

或双击 `启动LibraReader.bat`。当前安装包配置仍沿用早期的 `Libra Reader` 内部名称，以免改变现有用户数据目录；界面名称为 Yomi Reader。

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
- `ui-prototype/`：阅读器界面、书库逻辑、阅读解析与测试。
- `app.py`、`core.py`：早期 Python BookBridge 实验版，和当前桌面阅读器分开运行。

用户导入的图书、阅读记录、账号信息及构建产物不属于源码，不应提交到仓库。本项目不附带任何受版权保护的书籍。

## 许可证

源码以 [MIT License](LICENSE) 发布。第三方依赖各自遵循其许可证。
