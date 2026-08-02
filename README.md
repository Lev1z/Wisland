# Wisland

Wisland 是一个面向 Windows 的轻量桌面灵动岛。它以 PyIsland 的视觉方向为参考，以 `tauri-island` 的公开源码为工程底座，重点服务 Codex 状态、Obsidian 快速记录和少量高频桌面信息。

当前版本是一次“先减后加”的底座整理：先保住胶囊交互，再按插件式边界接入真正需要的功能。

## 当前保留

- 顶部胶囊、鼠标穿透、展开/收起、拖动回弹和最小化指示条
- 本地时间与日期
- Windows SMTC 音乐状态、播放控制和可选歌词
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

1. Codex 状态：统一显示运行中、等待确认、完成、失败和耗时。
2. Obsidian 随手记：快捷输入并追加到指定 Vault/每日笔记。
3. 扩展协议：让新功能只提供状态、动作和展开面板，不直接侵入胶囊核心。

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
