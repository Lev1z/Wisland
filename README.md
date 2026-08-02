# Wisland

Wisland 是一个面向 Windows 的轻量桌面灵动岛。它以 PyIsland 的视觉方向为参考，以 `tauri-island` 的公开源码为工程底座，重点服务 Codex 状态、Obsidian 快速记录和少量高频桌面信息。

当前版本是一次“先减后加”的底座整理：先保住胶囊交互，再按插件式边界接入真正需要的功能。

## 当前保留

- 顶部胶囊、鼠标穿透、展开/收起、拖动回弹和最小化指示条
- 主页、音乐、日记与临时托盘四页结构，支持胶囊内滚轮切页
- Codex 真实剩余额度、任务状态和收起横条状态色
- Windows SMTC 音乐封面、专辑取色声波、播放控制和可选歌词
- Obsidian 日记 / 待办写入与当天待办摘要
- 仅在内存暂存文件路径的轻量文件托盘
- 麦克风、摄像头隐私状态指示
- 全屏/前台进程黑名单
- 系统托盘、开机自启、日志
- 本地任务事件通知入口（后续改造成统一 Codex 状态适配器）

## 已移除

- 内置通用 AI 聊天面板
- ADB 投屏与工具下载器
- IMAP 邮件
- Everything 搜索
- 天气与定位
- 剪贴板链接处理
- BetterNCM 安装器
- 自动更新器

这些功能不是 Wisland 的核心。需要时应作为独立适配器或扩展重新接入，避免主胶囊再次变成大而全的工具箱。

## 下一阶段

1. 自定义 S 态左右区域，包括内置 GIF 预设。
2. 继续验证不同文件来源、DPI 和多显示器下的临时托盘拖放。
3. 扩展协议：让新功能只提供状态、动作和页面，不直接侵入胶囊核心。

## 技术栈

- Tauri 2
- Rust + Windows API
- Vanilla TypeScript + Vite
- Windows SMTC
- Lyrix（可选歌词）

## 开发

需要 Windows 10/11、Node.js LTS、Rust stable 和 Tauri 2 的系统依赖。

```bash
npm install
npm run tauri dev
```

前端单独检查：

```bash
npm run build
```

桌面打包：

```bash
npm run tauri build
```

## 分支策略

- 上游参考：`upstream/tauri-island`
- 原始底座快照：`pyisland/tauri-island`
- Wisland 主线：`main`
- 上游变更按需挑选，不直接把所有新功能合并进主线

## 配置位置

设置与日志保存在系统配置目录下的 `wisland` 文件夹中。旧项目的配置不会自动覆盖 Wisland。
