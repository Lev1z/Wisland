# 统一主题

在设置的“自定义 → 主题”中选择，立即应用到胶囊、设置窗口与 Runtime 侧栏。

| 主题 | 表现 |
| --- | --- |
| 暗黑 | 深色背景，无动态边框 |
| 彩虹边框 | 深色背景，沿用原有 4 秒彩色旋转边框 |
| 白色边框 | 深色背景，沿用原有 6 秒白色旋转边框 |
| 毛玻璃 | 原生 Desktop Acrylic，系统不支持或禁用时回退为深色背景 |

旧配置的 `off`、`aurora`、`mono` 分别对应前三项，新增 `glass`。继续保留 `custom` 与已导入的边框素材；主题使用现有配置字段，不修改用户的图标素材、透明度或缩放。

三处窗口通过同一个 `appearance-changed` 事件同步。原生材质复用现有 DWM 实现，缓存未变化的材质，避免普通设置保存反复重建合成表面。设置窗口在隐藏状态准备材质；关闭再创建时清除旧窗口的材质缓存。

胶囊窗口包含透明留白，因此仅毛玻璃模式根据实际 DOM 轮廓更新原生圆角区域。稳态不持续轮询；尺寸、状态、DPI 或动画变化期间按渲染帧跟随，最小化时切换至顶部横条轮廓。侧栏继续使用现有原生视口裁切，未改动滑动时长与首帧预热。胶囊、设置菜单和 Inspector 的原有动画规则不变。

## 验证

- `node scripts/test-theme-ui.cjs`：三处主题、纯色回退、边框转速、横条裁切、设置过渡层清理及已有 transition 保持不变。
- `node scripts/test-settings-ui.cjs`：三种窗口尺寸、卡片网格与控件。
- `node scripts/test-tray-ui.cjs`：36 组侧栏界面回归。
- `node scripts/test-tray-native.cjs --release --display --runtime --themes`：四主题跨窗口同步、设置重建、胶囊定位、侧栏滑动 / 反向动画和 Runtime；通过 `WISLAND_SETTINGS_CONFIG_DIR`、`CODEX_HOME` 和 `WISLAND_UPDATE_CONFIG_DIR` 隔离测试数据。
- `cargo test --lib`（在 `src-tauri` 目录）：Rust 回归。

浏览器截图不包含 Windows 合成的桌面毛玻璃。跨机器的首帧、裁切边缘和观感仍需测试版实机验收。
