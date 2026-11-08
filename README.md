<div align="center">
  <img src="src/assets/wisland-icon.png" width="112" alt="Wisland 图标">

# Wisland

一枚为 Codex、音乐与专注工作流打造的 Windows 桌面灵动岛。

[![Release](https://img.shields.io/github/v/release/Lev1z/Wisland?style=flat-square)](https://github.com/Lev1z/Wisland/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Lev1z/Wisland/total?style=flat-square)](https://github.com/Lev1z/Wisland/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white)
[![License](https://img.shields.io/github/license/Lev1z/Wisland?style=flat-square)](LICENSE)

**简体中文** · [Eng](README_EN.md)
</div>

Wisland 常驻于屏幕顶部，用一枚克制的胶囊集中呈现 Codex 状态与额度、媒体信息、Obsidian 随手记和临时文件，并提供无需离开当前工作的快捷操作。

<p align="center">
  <img src="docs/assets/wisland-capsule.png" width="236" alt="Wisland 胶囊界面">
</p>

## 功能亮点

- **Codex 状态与额度**：同心圆外环显示一周额度、内环显示 5 小时额度；状态灯以绿色、橙色和灰色区分空闲、执行中与离线。
- **Codex 托盘态**：隐藏桌面胶囊，只在 Windows 标准系统托盘显示随任务状态变色的额度环；悬停查看数字、点击展开 Windows 风格详情，支持仅周额度账户。
- **音乐、歌词与控制**：读取 Windows SMTC 的歌曲、封面、进度与播放状态，支持播放控制、音量、专辑取色声波和歌词时间校准。
- **Obsidian 随手记**：向指定 Vault 快速写入日记、待办和普通记录，并管理当天条目。
- **临时文件托盘**：暂存拖入文件的路径，可再次拖出或打开，不复制和修改原文件。
- **灵活导航与外观**：在 Classic 图标栏和 Option Wheel 之间切换，支持页面排序、缩放、透明度、边框以及图片或 GIF 素材。
- **桌面行为**：支持中键锁定展开、拖动回弹、顶部最小化横条、全屏/进程黑名单、开机自启和系统托盘。
- **环境检查**：首次启动时检查 WebView2、Codex Desktop、Codex CLI、Hooks、媒体服务和 Obsidian，并提供对应修复入口。

## 下载与安装

从 [GitHub Releases](https://github.com/Lev1z/Wisland/releases/latest) 下载最新的 `Wisland_<版本>_x64-setup.exe` 并运行。

建议使用安装包，而不是单独复制构建目录中的 `Wisland.exe`；安装包能够正确配置升级、卸载和开始菜单快捷方式。

### 系统要求

- 64 位 Windows 10 或 Windows 11
- Microsoft Edge WebView2 Runtime（Windows 11 通常已包含）
- 可选：Codex Desktop 与 Codex CLI，用于状态和额度功能
- 可选：支持 Windows SMTC 的媒体播放器
- 可选：Obsidian，用于随手记功能

### v0.1.5 更新摘要

- 新增标准系统托盘模式，可从胶囊右键切换，并单独设置默认启动模式。
- 托盘额度环用颜色显示任务状态；详情支持 5h / 1w 双额度及仅周额度账户。
- 新增原生毛玻璃详情面板，以任务栏上沿为固定边界展开、收起；修复动画白边、背景闪烁和任务栏遮挡。
- 托盘模式独立更新状态与额度；设置中的“关于”和侧栏从应用读取版本号。
- 实现过程与回归检查见 [托盘动画修复复盘](docs/tray-animation-notes.md)。

### v0.1.4 更新摘要

- Codex 额度环升级为白色同心双环：外环显示一周额度，内环显示 5 小时额度。
- Page 1 下方同时显示 `1week`、`5h` 的剩余百分比和当前任务状态。
- 保留原有环境检查、缓存与额度服务断线回退行为。

## 快速上手

1. 首次启动会进入环境检查；在胶囊展开状态中可查看完整结果并处理缺失项。
2. 将鼠标移入屏幕顶部中央的胶囊即可展开，移开约 0.5 秒后自动收起。
3. 在胶囊上滚动鼠标滚轮，切换时间、音乐、日记和文件托盘页面。
4. 中键单击可锁定或解除展开状态；右键打开快捷菜单。
5. 将胶囊向屏幕顶部拖动可收成小横条，单击横条即可恢复。
6. 在设置的 Codex 页面安装 Hooks，并在 Codex 提示时完成信任确认。
7. 在设置的日记页面选择 Obsidian Vault 和日记目录，即可开始快速记录。

## Codex 集成说明

### Runtime 侧栏（当前开发版本，未发布）

托盘详情已升级为右侧全高度侧栏：顶部保留状态和额度，下方提供 DSH 风格的统一事件时间线、滚动跟随及内嵌 Inspector。事件保留彩条和两字标签，左侧标注轮次与日志实际记录的模型调用完成点，不再使用 Turn / Step 嵌套卡片。旧日志未记录模型调用边界时明确提示。侧栏失焦保持显示与毛玻璃外观，不抢回焦点。使用方式、数据范围和测试入口见 [Runtime 侧栏说明](docs/runtime-sidebar.md)。

### 胶囊态与托盘态

- 右键胶囊，选择“切换至托盘态”。胶囊隐藏，只保留 Windows 标准通知区域中的额度环图标，不显示常驻浮窗。图标可能位于系统托盘的折叠区域，可按个人偏好将它拖到常显区域。
- 额度环沿用绿色（空闲）、橙色（执行中）、灰色（离线）的状态配色；外环对应一周，内环对应 5 小时。
- 标准托盘仅占一个图标位置；悬停提示显示 `5h` / `1w` 百分比。如果接口没有返回 5 小时限额，只显示一个周额度环和周额度信息，不把缺失限额当成 `0%`。
- 点击系统托盘图标，从屏幕右侧展开约 525px 宽的 Runtime 侧栏，高度从工作区顶部延伸至任务栏上方。顶部显示一条或两条额度进度、百分比与重置时间，不重复显示额度环。失焦时保持显示；按 Esc、Alt+F4 或点击右上角隐藏按钮收起；在 Inspector 中首次 Esc 返回轨迹列表。
- Windows 11 22621 及以上使用系统原生 Desktop Acrylic 毛玻璃、圆角和阴影。侧栏向左滑出（约 240ms）、向右收回（约 170ms），右边缘固定裁切；动画按 Windows 合成节奏更新。跟随深浅主题；关闭系统透明效果、开启高对比度或节电模式时使用纯色背景，关闭系统动画时立即显示/隐藏。较早的 Windows 版本保留纯色兼容界面。
- 右键系统托盘图标选择“显示胶囊”，可随时切回；设置 → 常规可切换当前模式，也可单独选择下次启动的默认模式。
- 托盘态独立在后台更新状态与额度，不依赖隐藏胶囊的刷新。短时查询失败显示上次成功数据并作标记，最长保留 6 小时；从设置手动运行环境检查会切回胶囊。

Wisland 使用 Codex 生命周期 Hooks 同步任务开始与完成状态，并通过已登录的 Codex CLI 获取额度。安装 Hooks 后应完全重启 Codex，使新配置生效。

Codex App 的“设置 → 钩子”页面需要已知的项目根目录才会发起查询；尚未打开项目时，即使 Hook 已被识别并正常执行，设置页也可能显示“未找到钩子”。可以先在 Codex 中打开一个项目，再返回设置页确认；运行时回复下方出现 Hook 信息同样说明配置已被加载。

如果 PowerShell 因执行策略阻止 `codex.ps1`，可以改用：

```powershell
& "$env:APPDATA\npm\codex.cmd"
```

## 页面说明

### 时间 / Codex

S 态中央显示时钟，左侧同心圆显示 Codex 剩余额度：外环代表一周窗口，内环代表 5 小时窗口。展开后，下方以 `1week: xx% - 5h: xx% - 状态` 的格式显示详情。右侧状态灯含义如下：

- 绿色：Codex 在线且当前空闲，或最近任务已完成
- 橙色：Codex 正在执行任务
- 灰色：Codex 未启动、已退出或状态不可用

额度读取依赖单独安装并登录的 Codex CLI。Wisland 通过 `codex app-server` 的账户额度接口读取数据；短时连接失败时会保留最近一次成功结果并标记为待刷新。

### 音乐

Wisland 读取 Windows SMTC 媒体会话，因此播放器必须向系统提供媒体信息。网易云音乐若未被发现，请在其“设置 → 系统设置”中开启系统媒体控制（SMTC），再从 Wisland 的“设置 → 行为”重新运行环境检查。

### Obsidian

Wisland 直接读写你选择的本地 Vault。配置日记目录后，可在胶囊中写入随手记和待办；写入前请确认目录与现有 Obsidian 结构一致。

### 临时文件托盘

拖入胶囊的文件只在当前运行期间保存路径。退出 Wisland 后列表会清空，原文件不会被修改、删除或上传。

## 本地开发

开发环境需要 Node.js LTS、Rust stable、WebView2，以及 Tauri 2 所需的 Windows C++ 编译工具。

### 项目结构

```text
Wisland/
├─ src/                     # TypeScript 前端
│  ├─ modules/             # 胶囊交互、媒体、Codex、Obsidian 等功能模块
│  ├─ runtime.ts           # 统一时间线、会话切换和摘要区域 Inspector 抽屉
│  └─ assets/              # 应用图标与前端静态资源
├─ public/
│  ├─ themes/              # 内置胶囊主题
│  └─ assets/visuals/      # 内置图片与动图素材
├─ src-tauri/               # Tauri / Rust 桌面端
│  ├─ src/                 # 窗口、媒体、设置、日志及系统集成
│  │  ├─ runtime.rs        # 只读 JSONL 增量读取与事件投影
│  │  └─ display.rs        # 分辨率、DPI、工作区变化处理
│  ├─ icons/               # Windows 与安装包图标
│  └─ windows/             # NSIS 安装脚本扩展
├─ scripts/                 # Codex 状态 Hook 脚本与资源生成工具
├─ docs/assets/             # README 使用的项目图片
├─ index.html               # 主胶囊窗口入口
├─ settings.html            # 设置窗口入口
├─ tray.html                # 标准托盘图标打开的 Codex Runtime 侧栏
└─ package.json             # 前端依赖与开发命令
```

```powershell
npm install
npm run tauri dev
```

构建前端：

```powershell
npm run build
```

构建 Windows 应用和 NSIS 安装包：

```powershell
npm run tauri build
```

默认产物位于：

- `src-tauri/target/release/wisland.exe`
- `src-tauri/target/release/bundle/nsis/Wisland_<版本>_x64-setup.exe`

## 数据与隐私

Wisland 的设置、Codex 状态和日志保存在 `%APPDATA%\wisland`。Obsidian 内容仅写入用户指定的本地 Vault；临时文件托盘不会上传或复制文件。歌词与 Codex 额度功能仅在使用时向相应服务发起请求。

## 技术栈

- [Tauri 2](https://tauri.app/)
- Rust 与 Windows API
- Vanilla TypeScript 与 Vite
- Windows System Media Transport Controls（SMTC）
- [Lyrix](https://crates.io/crates/lyrix)

## 致谢

Wisland 参考了 PyIsland 的视觉方向，并从 `tauri-island` 的公开代码演进而来；当前主线已围绕 Codex 与个人桌面工作流进行了精简和重构。

## 许可证

本项目采用 [MIT License](LICENSE)。
