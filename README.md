# Wisland

Wisland 是一个面向 Windows 的轻量桌面灵动岛。它常驻在屏幕顶部，用一枚尽量克制的胶囊集中展示 Codex、音乐、Obsidian 和临时文件等高频信息，同时保留快速操作入口。

项目参考 PyIsland 的视觉方向，并从 `tauri-island` 的公开代码演进而来；当前主线已围绕个人工作流完成精简和重构。

## 常用功能

- **Codex 状态**：左侧圆环显示剩余额度，右侧指示灯区分空闲、运行中与离线；Codex 退出后自动转为灰色。
- **音乐与歌词**：读取 Windows SMTC 的歌曲、封面、进度与播放状态，支持播放控制、音量、专辑取色声波和按播放器校准歌词时间。
- **Obsidian 随手记**：向指定 Vault 快速写入日记、待办和普通记录，并在胶囊中查看、完成或删除当天条目。
- **临时文件托盘**：拖入文件后暂存路径，之后可以从胶囊再次拖出或打开；Wisland 不复制原文件。
- **两种导航**：可在 Classic 图标栏与 Option Wheel 之间切换，并拖动调整页面顺序。
- **外观定制**：支持胶囊缩放、透明度、边框效果，以及 S 态左右区域的图片或 GIF。
- **桌面行为**：支持中键锁定展开、拖动回弹、最小化横条、全屏/进程黑名单、开机自启和系统托盘。

## 快速使用

1. 启动 Wisland 后，将鼠标移入屏幕顶部中央的黑色胶囊区域即可展开；移开约 0.5 秒后自动收起。
2. 在胶囊上滚动滚轮切换时间、音乐、日记和文件托盘页面。
3. 中键单击可锁定或解除展开状态；右键打开“收起 / 设置”菜单。
4. 将胶囊向屏幕顶部拖动可收成小横条，单击横条即可唤醒。
5. 在设置的“Codex”页面安装 Hooks，并重启 Codex，即可同步任务开始和完成状态。
6. 在设置的“日记”页面选择 Obsidian Vault 和日记目录，即可使用快速记录。

## 页面说明

### 时间 / Codex

S 态中央显示时钟，左侧是 Codex 剩余额度圆环，右侧状态灯含义如下：

- 绿色：Codex 在线且当前空闲，或任务已经完成
- 橙色：Codex 任务进行中
- 灰色：Codex 未启动、已退出或状态不可用

### 音乐

Wisland 读取 Windows 的 SMTC 媒体会话，因此播放器需要向系统提供媒体信息。播放过一次的播放器会出现在设置中，可单独调整歌词补偿。

### Obsidian

Wisland 直接读写你选择的 Vault。配置日记目录后，可以在胶囊里写入随手记和待办；写入前请确认目录与现有 Obsidian 结构一致。

### 临时文件托盘

拖入胶囊的文件只在本次运行的内存中保存路径。退出 Wisland 后列表会清空，原文件不会被修改或删除。

## 安装与构建

预编译安装包位于 GitHub 仓库的发布内容或本地构建目录。开发环境需要 Windows 10/11、Node.js LTS、Rust stable、WebView2 和 Tauri 2 所需的 Windows 编译组件。

```bash
npm install
npm run tauri dev
```

生成前端产物：

```bash
npm run build
```

生成 Windows 可执行文件与 NSIS 安装包：

```bash
npm run tauri build
```

默认产物位于：

- `src-tauri/target/release/Wisland.exe`
- `src-tauri/target/release/bundle/nsis/Wisland_<版本>_x64-setup.exe`

## 数据与隐私

设置、Codex 状态和日志保存在 `%APPDATA%\wisland`。Obsidian 内容仅写入用户指定的本地 Vault；临时文件托盘不上传或复制文件。歌词与 Codex 额度所需的网络请求由对应功能按需发起。

## 技术栈

- Tauri 2
- Rust + Windows API
- Vanilla TypeScript + Vite
- Windows SMTC
- Lyrix

## 分支

- Wisland 主线：`main`
- 原始底座快照：`pyisland/tauri-island`
- 上游参考：`upstream/tauri-island`

上游变化会按需挑选，不直接把所有功能合并回 Wisland。

## 项目主页

[github.com/Lev1z/Wisland](https://github.com/Lev1z/Wisland)
