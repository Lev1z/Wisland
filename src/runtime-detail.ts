// Presentation model only: all facts come from retained JSONL fields, never
// from the global status lamp or from guessing the outcome of a tool call.
export type RuntimeEvent = {
  id: string; turnId: string; turnNumber: number | null;
  modelCall: { responseId: string; number: number } | null; kind: string; summary: string;
  timestamp: string | null; sourceType: string; callId: string | null; status: string | null;
};
type RecordData = { payload?: Record<string, unknown>; [key: string]: unknown };
export type EventDetail = {
  event: RuntimeEvent;
  detail: { raw: RecordData; mirror?: RecordData; content: string; byteOffset: number; rolloutId?: string };
  related: { event: RuntimeEvent; detail: EventDetail["detail"] }[];
};
type Entry = Pick<EventDetail, "event" | "detail">;
export type Fact = { label: string; value: string; tone?: "error" | "success" };
type Notice = { text: string; tone?: "error" | "success" };
export type DetailBlock = { id: string; title: string; text: string; format: "markdown" | "code" | "json"; facts?: Fact[]; secondary?: boolean; error?: boolean; notice?: Notice; report?: string };
export type DetailOverview = { title: string; lead?: Notice; facts: Fact[]; blocks: DetailBlock[]; technical: Record<string, unknown> };
type ObjectValue = Record<string, unknown>;
const present = (value: unknown): boolean => value !== undefined && value !== null && value !== "";
export function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
// Decode only an entire, valid JSON container. Literal backslashes in paths,
// patches, malformed/truncated JSON and ordinary prose must remain untouched.
export function parseContainer(value: unknown): unknown {
  if (typeof value !== "string" || !/^[\s]*[\[{]/.test(value)) return value;
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" ? parsed : value; }
  catch { return value; }
}
const printable = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
const payload = (raw: RecordData): ObjectValue => {
  const envelope = object(raw.payload);
  return present(envelope.item) && typeof envelope.item === "object" ? object(envelope.item) : envelope;
};
const first = (sources: ObjectValue[], keys: string[]): unknown => {
  for (const source of sources) for (const key of keys) if (present(source[key])) return source[key];
  return undefined;
};
const field = (source: ObjectValue, keys: string[]): unknown => {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  return undefined;
};
const sourceFields = (entry: Entry): ObjectValue[] => [payload(entry.detail.raw), object(entry.detail.raw.payload),
  ...(entry.detail.mirror ? [payload(entry.detail.mirror), object(entry.detail.mirror.payload)] : [])];
const toolName = (entry: Entry): string => {
  const p = payload(entry.detail.raw);
  const name = first([p], ["name", "tool", "type"]);
  return typeof name === "string" ? name : entry.event.sourceType.split(".").pop() ?? "工具调用";
};
const statusNames: Record<string, string> = {
  completed: "已完成", failed: "失败", error: "异常", aborted: "已中断", interrupted: "已中断",
  in_progress: "进行中（记录时）", running: "运行中（记录时）", started: "已开始（记录时）", cancelled: "已取消",
};
function secondsText(seconds: number): string {
  if (seconds < 60) return `${Number(seconds.toFixed(3))} 秒`;
  const rounded = Math.round(seconds * 10) / 10;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded / 60) % 60;
  const rest = Number((rounded % 60).toFixed(1));
  return `${hours ? `${hours} 小时 ` : ""}${minutes} 分 ${rest} 秒`;
}
function commandInput(params: ObjectValue): { args: unknown; command: unknown; fields: ObjectValue; key?: string } {
  const args = parseContainer(field(params, ["arguments", "input", "action", "command"]));
  const fields = object(args);
  const key = ["cmd", "command"].find(k => present(fields[k]));
  return { args, command: key ? fields[key] : params.command, fields, key };
}
// Strip only unambiguous shell launchers. Never join arbitrary argv into an
// executable command: quoting and argument boundaries would be lost.
function readableCommand(command: unknown): unknown {
  if (!Array.isArray(command) || !command.every(arg => typeof arg === "string")) return command;
  const [executable, ...args] = command as string[];
  const shell = executable?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "");
  const flags = args.slice(0, -2).map(arg => arg.toLowerCase());
  const switchName = args.at(-2)?.toLowerCase();
  if ((shell === "pwsh" || shell === "powershell") && switchName === "-command") {
    for (let i = 0; i < flags.length; i++) {
      if (["-nologo", "-noprofile", "-noninteractive"].includes(flags[i])) continue;
      if (flags[i] === "-executionpolicy" && flags[i + 1] === "bypass") { i++; continue; }
      return command;
    }
    return args.at(-1);
  }
  if (["sh", "bash", "zsh"].includes(shell ?? "") && args.length === 2 && ["-c", "-lc"].includes(switchName ?? "")) return args[1];
  if (shell === "cmd" && switchName === "/c" && flags.every(flag => ["/d", "/s"].includes(flag))) return args.at(-1);
  return command;
}
function outputValue(params: ObjectValue, fallback?: unknown): unknown {
  const output = parseContainer(field(params, ["output", "aggregated_output", "content_items", "result"]) ?? fallback);
  const textOnly = Array.isArray(output) && output.length > 0 && output.every(v => typeof v === "string" ||
    (Object.keys(object(v)).every(k => ["type", "text"].includes(k)) &&
      (object(v).type === undefined || object(v).type === "text") && typeof object(v).text === "string"));
  return textOnly ? output.map(v => typeof v === "string" ? v : object(v).text).join("\n") : output;
}
function outcome(sources: ObjectValue[]): Notice {
  const exit = first(sources, ["exit_code"]);
  const status = first(sources, ["status"]);
  const success = first(sources, ["success"]);
  const error = first(sources, ["error"]);
  const hasExit = typeof exit === "number" && Number.isInteger(exit);
  if ((present(error) && error !== false) || success === false || (hasExit && exit !== 0) ||
    (typeof status === "string" && /^(failed|error|aborted|interrupted|cancelled)$/.test(status))) {
    return { text: hasExit && exit !== 0 ? `进程异常退出（退出码 ${exit}）` : "记录报告失败或中断", tone: "error" };
  }
  if (hasExit && exit === 0) return { text: "进程正常退出", tone: "success" };
  if (success === true) return { text: "工具报告执行成功", tone: "success" };
  if (status === "completed") return { text: "执行已结束，未记录成功标志" };
  if (typeof status === "string" && statusNames[status]) return { text: statusNames[status] };
  return { text: "已收到返回，未记录退出状态" };
}
// The transport's completed-script envelope may contain several printed exec
// return objects. Admit only a complete sequence with known response fields;
// malformed, mixed or truncated text falls back intact, never partially eaten.
function scriptReturns(output: unknown): { seconds: number; returns: ObjectValue[] } | undefined {
  if (typeof output !== "string" || output.length > 128 * 1024) return;
  const match = /^Script completed\r?\nWall time (\d+(?:\.\d+)?) seconds\r?\nOutput:\r?\n([\s\S]*)$/.exec(output);
  if (!match || !Number.isFinite(Number(match[1]))) return;
  const text = match[2];
  const returns: ObjectValue[] = [];
  let at = 0;
  while (at < text.length) {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    if (at === text.length) break;
    if (text[at] !== "{" || returns.length >= 32) return;
    const start = at;
    let depth = 0, quoted = false, escaped = false;
    for (; at < text.length; at++) {
      const ch = text[at];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") { if (--depth === 0) { at++; break; } }
    }
    if (depth !== 0 || quoted) return;
    const value = object(parseContainer(text.slice(start, at)));
    if (typeof value.chunk_id !== "string" || typeof value.output !== "string" ||
      !(typeof value.wall_time_seconds === "number" || typeof value.exit_code === "number" || typeof value.session_id === "number")) return;
    returns.push(value);
  }
  return returns.length ? { seconds: Number(match[1]), returns } : undefined;
}
function outputReport(text: unknown): string | undefined {
  if (typeof text !== "string") return;
  // Report an explicit test-runner statement, not an inferred project outcome.
  const match = /^PASS:\s+(\d+)\s+(?:[\w-]+\s+){0,4}(UI scenarios|tests|test cases)(?:\s*\(|,|\s*$)/m.exec(text);
  if (match) return `输出报告：${match[1]} ${match[2] === "UI scenarios" ? "组界面测试" : "项测试"}通过`;
  const rust = /^test result: ok\. (\d+) passed;/m.exec(text);
  return rust ? `输出报告：${rust[1]} 项测试通过` : undefined;
}
function factsFor(entry: Entry, extra: ObjectValue[] = []): Fact[] {
  const sources = [...extra, ...sourceFields(entry)];
  const facts: Fact[] = [];
  const add = (label: string, value: unknown, tone?: Fact["tone"]): void => {
    if (present(value)) facts.push({ label, value: printable(value), tone });
  };
  const status = first(sources, ["status"]) ?? entry.event.status;
  if (typeof status === "string") add("状态", statusNames[status] ?? status, /^(failed|error|aborted|interrupted)$/.test(status) ? "error" : undefined);
  const success = first(sources, ["success"]);
  if (typeof success === "boolean") add("执行成功", success ? "是" : "否", success ? "success" : "error");
  const exit = first(sources, ["exit_code"]);
  if (typeof exit === "number") add("退出码", exit, exit === 0 ? "success" : "error");
  const ms = first(sources, ["duration_ms"]);
  const seconds = first(sources, ["wall_time_seconds"]);
  const duration = first(sources, ["duration"]);
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) add("耗时", secondsText(ms / 1000));
  else if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) add("耗时", secondsText(seconds));
  else if (typeof object(duration).secs === "number") {
    const d = object(duration);
    const total = (d.secs as number) + (typeof d.nanos === "number" ? d.nanos / 1e9 : 0);
    if (Number.isFinite(total) && total >= 0) add("耗时", secondsText(total));
  } else if (present(duration)) add("耗时（原值）", duration); // Unknown unit: do not assume seconds.
  add("模型", first(sources, ["model", "model_slug"]));
  add("阶段", first(sources, ["phase"]));
  return facts;
}

export function overviewFor(detail: EventDetail): DetailOverview {
  const { event, detail: data } = detail;
  const p = payload(data.raw);
  const sources = sourceFields(detail);
  const result = outputValue(p);
  const resultObject = object(result);
  const model: DetailOverview = {
    title: event.kind === "tool" ? toolName(detail) : event.kind === "result" ? "执行结果"
      : event.kind === "model" ? `模型调用${event.modelCall ? ` #${event.modelCall.number}` : ""}`
      : ({ user: "用户消息", assistant: "助手消息", summary: "思考摘要", context: "上下文记录", record: "其他记录", system: "系统消息", error: "异常记录", compaction: "上下文压缩", lifecycle: "回合记录" }[event.kind] ?? "事件记录"),
    facts: factsFor(detail, ["tool", "result"].includes(event.kind) ? [resultObject] : []), blocks: [],
    technical: Object.fromEntries(Object.entries({ source: event.sourceType, timestamp: event.timestamp,
      turn_id: event.turnId === "unattributed" ? undefined : event.turnId, response_id: event.modelCall?.responseId,
      call_id: event.callId, byte_offset: data.byteOffset, rollout_id: data.rolloutId,
      ...(data.mirror ? { mirrored_record: "另一条源记录已合并；请在「原始内容」查看" } : {}),
    }).filter(([, value]) => present(value))),
  };
  const block = (id: string, title: string, value: unknown, options: Partial<DetailBlock> = {}): void => {
    if (!present(value)) return;
    const decoded = parseContainer(value);
    model.blocks.push({ id, title, text: printable(decoded), format: typeof decoded === "string" ? "code" : "json", ...options });
  };
  const inputs = (entry: Entry, prefix = "", secondary = false): void => {
    const params = payload(entry.detail.raw);
    const { args, command, fields, key: commandKey } = commandInput(params);
    if (present(command)) {
      const readable = readableCommand(command);
      block(`${prefix}command`, prefix ? "关联命令" : "执行的命令", readable, { secondary });
      if (readable !== command) model.technical[`${prefix}command_argv`] = command;
      if (!secondary && typeof (fields.workdir ?? params.cwd) === "string") {
        model.facts.push({ label: "工作目录", value: String(fields.workdir ?? params.cwd) });
      }
      const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== commandKey));
      if (Object.keys(rest).length) block(`${prefix}params`, "其他参数", rest, { secondary: true });
    } else {
      block(`${prefix}input`, prefix ? `关联工具 · ${toolName(entry)}` : params.command !== undefined ? "命令" : "工具输入",
        args === "" ? "（空输入）" : args ?? entry.detail.content, { secondary });
    }
  };
  const outputBlock = (entry: Entry, output: unknown, id: string, title: string, withFacts: boolean, separateReturn = false): void => {
    const value = object(output);
    const outputKey = ["output", "stdout"].find(key => typeof value[key] === "string");
    const ownSources = separateReturn ? [value] : [value, ...sourceFields(entry)];
    // A printed child response must not inherit its outer script's status/time.
    let facts = withFacts ? factsFor(separateReturn ? {
      event: { ...entry.event, status: null }, detail: { ...entry.detail, raw: { payload: value }, mirror: undefined },
    } : entry, [value]) : undefined;
    if (separateReturn) facts = facts?.filter(fact => !["状态", "退出码", "执行成功"].includes(fact.label));
    if (outputKey) {
      const notice = separateReturn ? outcome(ownSources) : undefined;
      block(id, title, value[outputKey] || "（空输出）", { facts, notice, report: outputReport(value[outputKey]) });
      block(`${id}-stderr`, "标准错误输出", value.stderr, { error: true });
      if (value.error !== false) block(`${id}-error`, "错误", value.error, { error: true });
      const consumed = [outputKey, "stderr", "error", "wall_time_seconds", "duration_ms", ...(separateReturn ? [] : ["exit_code", "status", "success"])];
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => !consumed.includes(key)));
      if (Object.keys(rest).length) block(`${id}-extra`, separateReturn ? `${title} · 附加字段` : "输出附加字段", rest, { secondary: true });
    } else {
      block(id, title, output === "" || output == null ? "（空输出）" : output, { facts, report: outputReport(output) });
    }
  };
  const outputs = (entry: Entry, id: string, title: string, withFacts: boolean): void => {
    const rp = payload(entry.detail.raw);
    const output = outputValue(rp, entry.detail.content);
    const batch = scriptReturns(output);
    if (!batch) { outputBlock(entry, output, id, title, withFacts); return; }
    if (entry === detail) {
      const failed = batch.returns.filter(value => outcome([value]).tone === "error").length;
      const outerFailed = outcome(sourceFields(entry)).tone === "error";
      model.title = batch.returns.length > 1 ? "批量调用结果" : "脚本调用结果";
      model.lead = { text: `收到 ${batch.returns.length} 条返回${failed ? ` · ${failed} 条异常` : ""}${outerFailed ? " · 外层记录有错误" : ""}，各项结果如下`,
        tone: failed || outerFailed ? "error" : undefined };
      model.facts = model.facts.map(fact => ({ ...fact, label: `外层${fact.label}` }));
      model.facts.push({ label: "外层脚本耗时", value: secondsText(batch.seconds) });
    } else {
      block(`${id}-script`, "关联脚本", `收到 ${batch.returns.length} 条返回 · 外层脚本耗时 ${secondsText(batch.seconds)}`);
    }
    batch.returns.forEach((value, index) => outputBlock(entry, value, `${id}-return-${index + 1}`, `返回 ${index + 1}`, true, true));
  };
  if (p.error !== false) block("error", "错误", p.error, { error: true });
  if (event.kind === "tool") {
    if (present(commandInput(p).command)) {
      model.title = "执行命令";
      model.lead = outcome([resultObject, ...sources, { status: event.status }]);
      if (!present(result) && !present(first(sources, ["status", "exit_code", "success", "error"])) && !event.status) {
        model.lead = { text: detail.related.some(r => r.event.kind === "result") ? "已记录命令；关联返回见下方" : "已记录命令，当前记录未附带执行结果" };
      }
      model.technical.exit_code = first([resultObject, ...sources], ["exit_code"]);
      model.facts = model.facts.filter(fact => !["状态", "退出码"].includes(fact.label));
    }
    inputs(detail);
    if (result !== undefined && result !== null) outputs(detail, "output", "执行结果", false);
    for (const related of detail.related.filter(r => r.event.kind === "result")) outputs(related, `related-${related.event.id}`, "关联结果", true);
  } else if (event.kind === "result") {
    model.lead = outcome([resultObject, ...sources, { status: event.status }]);
    outputs(detail, "output", "输出", false);
    for (const related of detail.related.filter(r => r.event.kind === "tool")) inputs(related, `related-${related.event.id}-`, true);
  } else if (event.kind === "model") {
    const usage = Object.assign({}, ...sources.slice().reverse().map(s => object(parseContainer(s.usage ?? s.token_usage)))) as ObjectValue;
    const keys: [string, string][] = [["input_tokens", "输入 token"], ["cached_input_tokens", "缓存输入 token"], ["output_tokens", "输出 token"], ["reasoning_output_tokens", "推理输出 token"], ["total_tokens", "合计 token"]];
    for (const [key, label] of keys) if (typeof usage[key] === "number") model.facts.push({ label, value: String(usage[key]) });
    const remaining = Object.fromEntries(Object.entries(usage).filter(([key]) => !keys.some(([k]) => k === key)));
    if (Object.keys(remaining).length) block("usage-extra", "其他用量字段", remaining, { secondary: true });
    if (!model.facts.length) block("model-note", "记录", data.content);
  } else if (event.kind === "lifecycle" && ["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"].includes(String(p.type ?? event.sourceType.split(".").pop()))) {
    const type = String(p.type ?? event.sourceType.split(".").pop());
    const started = type.endsWith("started");
    const aborted = type === "turn_aborted";
    const failed = (present(p.error) && p.error !== false) || ["failed", "error"].includes(String(p.status));
    model.title = started ? "本轮已开始" : aborted ? "本轮已中断" : failed ? "本轮执行失败" : "本轮已结束";
    model.facts = model.facts.filter(f => f.label !== "状态").map(f => f.label === "耗时" ? { ...f, label: "本轮耗时" } : f);
    if (typeof p.time_to_first_token_ms === "number" && Number.isFinite(p.time_to_first_token_ms) && p.time_to_first_token_ms >= 0) {
      model.facts.push({ label: "本轮首 token", value: secondsText(p.time_to_first_token_ms / 1000) });
    }
    if (typeof p.last_agent_message === "string" && p.last_agent_message.trim()) {
      block("final-message", "最终回复", p.last_agent_message, { format: "markdown", text: p.last_agent_message });
    } else if (!started) {
      model.lead = { text: "这条记录未附带最终回复", tone: failed || aborted ? "error" : undefined };
    }
    block("reason", "中断原因", p.reason, { error: aborted });
    const consumed = ["type", "status", "duration_ms", "duration", "wall_time_seconds", "time_to_first_token_ms", "last_agent_message", "reason", "error", "turn_id", "root_turn_id", "started_at", "completed_at"];
    const other = Object.fromEntries(Object.entries(p).filter(([key]) => !consumed.includes(key)));
    if (Object.keys(other).length) block("lifecycle-extra", "其他记录字段", other, { secondary: true });
    for (const key of ["root_turn_id", "time_to_first_token_ms"]) if (present(p[key])) model.technical[key] = p[key];
  } else if (["user", "assistant", "summary", "system"].includes(event.kind)) {
    block("message", event.kind === "summary" ? "思考摘要" : "正文", data.content, { format: "markdown", text: data.content });
  } else if (event.kind === "error") {
    if (data.content && data.content !== printable(p.error)) block("message", "异常说明", data.content, { error: true });
  } else {
    // Generic fallback still exposes the payload, not just its type name.
    block("record", "记录内容", Object.keys(p).length ? p : data.content);
  }
  for (const key of ["started_at", "completed_at", "started_at_ms", "completed_at_ms", "thread_id"]) {
    const value = first(sources, [key]); if (present(value)) model.technical[key] = value;
  }
  return model;
}
