# Codex Runtime 侧栏（未发布）

## 使用

切换到托盘态后，点击标准系统托盘图标。原有详情窗口现在沿显示器右侧展开，内容宽度为 525 个逻辑像素，高度覆盖可用工作区，不遮挡任务栏。顶部保持状态与 5h / Weekly 额度；缺失的额度窗口不显示。

- 轨迹使用 DSH 风格的统一时间线，事件行高 24px，不再嵌套 Turn / Step 卡片。左侧窄栏标注轮次，右侧彩条、两字类型标签和摘要始终对齐；按 JSONL 文件顺序显示，不按工具归属重排。
- 默认选择最近修改的本地会话；下拉框可固定一个会话。会话列表显示最近 40 份日志，通过 `session_index.jsonl` 中的会话 ID 映射 Codex 标题，约每 3 秒同步重命名；无标题时回退文件标识。标题索引最多读取末尾 8 MiB，未命中的较旧标题也采用回退标识。
- `Live ↓` 跟随新事件。向上滚动会暂停跟随，点击按钮恢复。
- 点击事件打开侧栏内部 Inspector，只覆盖摘要区域。轮次列宽 34px；原时间线的轮次、彩条和两字标签留在原位，不复制另一套导航、不调暗列表。点击露出的原标签直接切换事件，也可在左列上滚动。右侧展示概述、工具参数、关联结果、可用元数据与原始记录。
- Inspector 打开时暂停滚动跟随并临时固定会话，关闭后恢复打开前的列表滚动位置与原来的会话选择模式；点击 `Live ↓` / `跟随 ↓` 可继续跟随。详情抽屉从右侧滑入并渐显（300ms），关闭时反向收回（220ms），可中途反向操作；系统关闭动画或启用减少动态效果时直接切换。原行按事件 ID 就地更新，锁定会话或增量刷新不替换左列节点。第一次 Esc 关闭 Inspector，之后 Esc 隐藏侧栏；隐藏不退出 Wisland。

侧栏失焦保持显示与背景材质，不切换为 Windows 非活动态的灰白背景，也不抢回输入焦点。通过隐藏按钮、Esc、Alt+F4 或切回胶囊关闭。顶部按钮顺序为刷新额度、设置、隐藏；底部不再显示“显示胶囊”，改用托盘右键菜单返回。托盘态右键菜单不再显示“切换至托盘态”。

## 数据契约

读取 `$CODEX_HOME/sessions/**/*.jsonl`，未设置时使用 `%USERPROFILE%\.codex\sessions`。仅识别 `rollout-*.jsonl`；不访问 `auth.json`，不修改 Codex 配置，不建立新的 Codex 控制连接，也不上传轨迹。

每 500ms 从已选文件的上次字节偏移继续读取；每 3 秒重新发现最近会话。等待完整换行后才解析，支持跨写入批次的 UTF-8 字符。日志缩短、更换或已读边界被重写时重建视图。同步速度受 Codex 写盘频率影响，不等同于逐 token 的运行时事件流。

- 支持 `event_msg` 的回合开始、完成、中断及消息；`response_item` 的消息、公开摘要、工具调用与结果；`compacted`；以及新格式 `item_completed` 的常见 TurnItem。
- 轮次使用日志中的 `turn_id`，左侧编号仅是本次加载记录中的顺序，历史裁剪时不重编号。没有标识的记录显示“未关联”，不猜测所属回合。
- 模型调用圆点只来自带非空 `response_id` 的 `token_usage_record` 或 `event_msg.raw_response_completed`；同一轮次的相同 ID 合并为一个标记。这些是**完成记录**，不推算请求起点、耗时、流式中间状态或缺失调用。`token_count` 是可能累计/重放的用量更新，不作为模型调用边界。旧日志没有这些字段时显示说明，不将 Step、工具调用或助手消息冒充模型调用。
- 工具和结果继续通过真实 `call_id` 在 Inspector 内关联。延迟结果保留原轮次标识，但在时间线中停留于实际写入位置。
- 同一消息的旧事件和原始响应镜像合并为一行，Inspector 保留两条来源。未知事件仍可查看原始记录。
- 未记录的耗时、成功状态和模型信息不推算。收到工具结果不自动等同于成功；日志尚无完成记录时不声称任务仍在运行。
- 只呈现公开摘要；省略原始推理正文、加密内容和二进制字段。Inspector 中的代码与 HTML 始终作为纯文本显示。
- 顶部状态灯和额度继续使用现有全局监控链路，不代表下拉框所选历史会话的当前状态。

内存与读取有界：首次最多读取文件末尾 4 MiB，每轮最多 512 KiB；单行超过 2 MiB 跳过；列表保留最近 800 个事件；Inspector 对原始记录和内容做限长处理，每段文本最多 32K 字符。超长文本显示截断提示，原始内容页同时标注限长与字段省略。压缩归档、云端会话，以及未落盘的内部事件不在本次数据源范围内。

## 窗口与动画

沿用 v0.1.5 的单窗口生命周期、Desktop Acrylic、高对比度/省电回退、隐藏首帧合成预热和可取消动画编号。展开 240ms 向左减速，收回 170ms 向右；内部内容宽度固定，通过原生视口宽度裁切，不逐帧修改窗口区域、透明度或毛玻璃属性。

Windows 无标题栏窗口仍有非客户区边距。Tauri `set_size` 接收客户区尺寸，而 `GetWindowRect` 返回外框尺寸，布局显式处理这个差异，保证外框右边缘不越过工作区、下沿不进入任务栏。显示器分辨率/DPI/工作区改变时更新已打开侧栏；隐藏侧栏不会因布局变化被打开。

侧栏创建后、首次显示前，在所属 UI 线程安装原生子类过程。仅将 `WM_NCACTIVATE` 的材质绘制状态交给 `DefWindowProcW(TRUE, -1)`，保持 Acrylic 活动外观并避免非客户区重绘；真实激活、失焦和键盘消息照常传递，销毁时移除子类。不在失焦后重新设置背景，不调用聚焦来维持外观。依据 [Microsoft 的非客户区激活消息说明](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-ncactivate)。

## 验证

```powershell
npm run build
npm run test:version
cd src-tauri
cargo test --lib
cargo build
cd ..
node scripts/test-tray-ui.cjs
node scripts/test-tray-native.cjs --display --runtime
```

界面测试使用模拟数据检查双额度/仅周额度/离线、深浅主题、三个 DPI、时间线行对齐与顺序、模型调用标记、Inspector 导航、安全文本与滚动恢复。原生测试使用自己创建的隔离 `CODEX_HOME` 检查文件追加、半个 UTF-8 字符、结果关联、会话锁定、路径拒绝和真实窗口开关。材质单元测试使用真实隐藏 HWND 验证非客户区消息处理不会夺取前台。实际毛玻璃在动画前几帧是否闪烁、跨机器失焦外观，仍需用户机器上的连续观察，不能仅凭截图或几何测试判定。

参考源码（只读、未复制其组件）：Codex 的 `protocol/src/protocol.rs`（`TokenUsageRecord` / `RawResponseCompletedEvent`）、`protocol/src/models.rs`、`protocol/src/items.rs`、`history/src/rollout_payload.rs`、`rollout/src/policy.rs`；DSH 的 `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`、`TrajectoryTable.module.css`、`trajectory-virtual-rows.ts`。Wisland 使用自己的 Rust 增量读取器及 Vanilla TypeScript 视图，不引入 DSH 运行时依赖。
