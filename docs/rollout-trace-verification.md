# Rollout Trace 验证记录

验证日期：2026-11-09。范围：验证本机已安装 Codex 的 Trace 能力，为后续可选数据源提供依据；本阶段不将 Trace 接入 Wisland，不修改 Codex 配置、既有会话或全局环境变量。

## 结论

本机两套运行时都能生成 Rollout Trace，且在响应结束前写出 `inference_started`。成功与失败终态通过同一个 `inference_call_id` 关联，官方内置 reducer 能还原调用状态、起止时间及部分输出。它可以为前置模型标题提供真实请求开始证据，补足普通 JSONL 的缺口。

这是隔离 CLI 进程的实测结论。尚未验证正在运行的 Desktop 进程是否会继承指定环境变量，也未开启用户真实会话的 Trace。普通 JSONL 的保守关联仍是当前 Wisland 的数据路径。

## 实测版本

| 运行时 | 来源 | Trace schema | 成功 / 失败及还原 |
| --- | --- | --- | --- |
| `0.167.0-alpha.3.2` | 本机 Desktop 正在使用的 `LocalAppData/OpenAI/Codex/bin/.../codex.exe` | 2 | 通过 |
| `0.167.0` | 本机 `CODEX_HOME/packages/app-server-daemon/releases/.../bin/codex.exe` | 2 | 通过 |

检查时 Desktop 包版本为 `26.1103.3517.0`。包版本、已安装 PrimaryRuntime 包版本与实际运行的 CLI 版本不能互相替代；本次按进程路径确认待测二进制，并记录其 `--version` 与 SHA-256。

- `0.167.0-alpha.3.2`：`40ecc3d8b6899afd8f935a8cccb7d53ba41ffd7c199f679e186d30ddd0d0bf39`
- `0.167.0`：`edfdd48f8b458af0906e507b4cb05217b326c3d6e515e9f024e05e3b8d650f70`

`debug --help` 没有列出该子命令，但直接调用 `debug trace-reduce --help` 与实际还原均成功。因此不能单凭普通帮助菜单中没有这一项判定功能不存在。

本地 Codex 参考源码提交为 `3bae578af3`，其中 raw event schema 常量为 **1**，实际安装版写出 **2**。本次核对的公共事件包络及推理起止字段兼容，不能据此宣称两个版本的全部事件都兼容。后续读取器必须按 schema 做显式支持检测，未知版本保留 JSONL 回退，不能直接照搬旧源码结构。

## 可复现探针

运行 `scripts/probe-rollout-trace.cjs`，参数为显式选择的 Codex EXE 绝对路径，可传入多个版本：

```powershell
node scripts/probe-rollout-trace.cjs 'C:\absolute\path\to\codex.exe'
```

脚本在项目 `target/rollout-trace-probe-*` 内创建独立用户目录与 `CODEX_HOME`，只给测试子进程设置 `CODEX_ROLLOUT_TRACE_ROOT`。不读取真实登录文件，不复用真实会话，不重启或控制 Desktop。模型请求指向脚本自己的 `127.0.0.1` HTTP 服务；该服务不返回工具调用，不调用在线模型。子进程不继承账户密钥，关闭遥测导出与插件，并将 HTTP 代理指向拒绝转发的本地服务。这是应用级隔离，不是操作系统网络沙箱。

每个版本验证两个场景：

1. **正常响应**：发送 `response.created` 后保持 SSE 开启，轮询 Trace 确认 `inference_started` 已落盘，再发送助手输出与 `response.completed`。
2. **中途断流**：同样确认开始记录并发送部分助手输出，但不发送 `response.completed`，直接断开 SSE。重试上限为零，保证本场景只有一次请求。

断言覆盖：

- 恰好一次本地请求，且不带 Authorization 凭据。
- 响应尚未结束时已经观察到开始记录。
- schema 在明确核对过的范围内，事件 `seq` 递增、时间戳有效。
- 开始与终态的调用 ID、线程 ID、回合 ID 一致。
- 正常场景得到 `inference_completed`，断流得到 `inference_failed`；有部分输出的失败仍为失败。
- 请求与完整 / 部分响应的 payload 引用可读取，并限制在自己的 bundle 内。
- `debug trace-reduce` 成功，`state.inference_calls` 的状态、调用身份及起止时间与原始事件一致；失败仍保留部分输出引用。

每次运行保留 `report.json`、测试进程输出、`manifest.json`、`trace.jsonl`、`payloads/*.json` 与还原的 `state.json`。这些位于已忽略的 `target/`，不提交到仓库。探针不自动删除产物。四个场景均通过；本次模型请求均为合成数据，未消耗在线额度。

## 已核对的数据含义

- `manifest.json` 标识诊断包、rollout 与根线程；Trace 的诊断 ID 不等于产品会话 ID。
- `trace.jsonl` 的 `seq` 是写入顺序，`wall_time_unix_ms` 是观测时间。起止相减表示被记录的调用区间，不等于服务端纯推理耗时；本机时钟跳变时也不能盲目计算。
- `inference_started` 提供调用身份、模型、provider 和请求 payload；`inference_completed` 给出响应 ID 与响应 payload。
- `inference_failed` 单独记录错误和可选的 `partial_response_payload`。完整的工具输出、部分模型文本、用量记录都不能代替显式终态。
- reducer 输出中的 `inference_calls`、`tool_calls`、`code_cells`、`terminals`、`compactions` 有不同职责。一次 `exec` 内的工具操作不应被记成额外模型请求。

最后一项结构说明来自参考源码，当前探针只实际验证了普通推理的成功、失败与还原，未覆盖工具并发、取消、重试、多代理或压缩路径。

## 后续接入边界

1. **先确认启用方式**：环境变量必须到达实际执行请求的进程。在用户确认前，不为真实 Desktop 设置持久环境或重启应用；旧会话没有记录过的开始事件无法补回。
2. **按版本读取，增量消费**：按 manifest/schema 检测支持版本，等待完整事件与 payload，允许写盘延迟和缺失。Trace 本身是尽力记录，缺失不应使 Wisland 或 Codex 失败。
3. **用身份连接两条数据源**：优先通过线程、回合、响应与调用 ID 关联普通 JSONL；Trace 的一次网络尝试不直接等于普通时间线中的一个逻辑步骤。重试、重复与不完整尾部需单独测试。
4. **压缩不能一概而论**：参考源码 `core/src/compact.rs` 的本地压缩流显式使用 `InferenceTraceContext::disabled()`；其注释说明当前只建模远程压缩。后台压缩请求与稍后安装压缩历史也应分别处理。该限制依据参考源码，尚未在安装版实测。
5. **敏感内容与磁盘占用**：payload 可能包含完整提示、回答、工具参数、结果和路径。正式接入应明确本地存储位置、访问权限、留存与清理策略，并继续执行 Wisland 的原始推理 / 加密 / 二进制字段过滤。
6. **回退保持可读**：未启用、未知版本、记录缺失时继续使用普通 JSONL 的前置标题与“待关联”；只有真实开始记录才能显示请求正在进行，只有明确终态才能结束该状态。

## 参考依据

先核对了官方[环境变量文档](https://learn.chatgpt.com/docs/config-file/environment-variables)与 [CLI 参考](https://learn.chatgpt.com/docs/cli/reference)，本次读取内容中未检索到 `CODEX_ROLLOUT_TRACE_ROOT` / `trace-reduce` 的说明。因此这里不把它称作已由公开文档保证的稳定接口；功能存在性由安装版实测确认。

源码依据为本机 Codex `3bae578af3`：`codex-rs/rollout-trace/README.md`、`src/raw_event.rs`、`src/thread.rs`、`src/inference.rs`、`src/bundle.rs`，以及 `codex-rs/core/src/compact.rs`。参考源码只读，未改动 Codex。
