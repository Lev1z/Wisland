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
export type DetailBlock = { id: string; title: string; text: string; format: "markdown" | "code" | "json"; facts?: Fact[]; secondary?: boolean; error?: boolean };
export type DetailOverview = { title: string; facts: Fact[]; blocks: DetailBlock[]; technical: Record<string, unknown> };
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
  const name = first([p], ["name", "tool"]);
  return typeof name === "string" ? name : entry.event.sourceType.split(".").pop() ?? "工具调用";
};
const statusNames: Record<string, string> = {
  completed: "已完成", failed: "失败", error: "异常", aborted: "已中断", interrupted: "已中断",
  in_progress: "进行中（记录时）", running: "运行中（记录时）", started: "已开始（记录时）", cancelled: "已取消",
};
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
  if (typeof ms === "number" && ms >= 0) add("耗时", `${Number((ms / 1000).toFixed(3))} s`);
  else if (typeof seconds === "number" && seconds >= 0) add("耗时", `${seconds} s`);
  else if (typeof object(duration).secs === "number") {
    const d = object(duration);
    add("耗时", `${Number(((d.secs as number) + (typeof d.nanos === "number" ? d.nanos / 1e9 : 0)).toFixed(3))} s`);
  } else if (present(duration)) add("耗时（原值）", duration); // Unknown unit: do not assume seconds.
  add("模型", first(sources, ["model", "model_slug"]));
  add("阶段", first(sources, ["phase"]));
  return facts;
}

export function overviewFor(detail: EventDetail): DetailOverview {
  const { event, detail: data } = detail;
  const p = payload(data.raw);
  const sources = sourceFields(detail);
  const result = parseContainer(field(p, ["output", "aggregated_output", "content_items", "result"]));
  const resultObject = object(result);
  const model: DetailOverview = {
    title: event.kind === "tool" ? toolName(detail) : event.kind === "result" ? "执行结果"
      : event.kind === "model" ? `模型调用${event.modelCall ? ` #${event.modelCall.number}` : ""}`
      : ({ user: "用户消息", assistant: "助手消息", summary: "公开摘要", error: "异常记录", compaction: "上下文压缩", lifecycle: "回合记录" }[event.kind] ?? "事件记录"),
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
    const args = parseContainer(field(params, ["arguments", "input", "action", "command"]));
    const fields = object(args);
    const commandKey = ["cmd", "command"].find(key => present(fields[key]));
    if (commandKey) {
      block(`${prefix}command`, `${prefix ? "关联命令" : "命令"}`, fields[commandKey], { secondary });
      const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== commandKey));
      if (Object.keys(rest).length) block(`${prefix}params`, "其他参数", rest, { secondary: true });
    } else {
      block(`${prefix}input`, prefix ? `关联工具 · ${toolName(entry)}` : params.command !== undefined ? "命令" : "工具输入",
        args === "" ? "（空输入）" : args ?? entry.detail.content, { secondary });
    }
  };
  const outputs = (entry: Entry, id: string, title: string, withFacts: boolean): void => {
    const rp = payload(entry.detail.raw);
    const output = parseContainer(field(rp, ["output", "aggregated_output", "content_items", "result"]) ?? entry.detail.content);
    const value = object(output);
    // Known exec wrappers carry text plus useful facts. Keep unfamiliar members
    // available in a collapsed section, rather than silently dropping them.
    const outputKey = ["output", "stdout"].find(key => typeof value[key] === "string");
    const facts = withFacts ? factsFor(entry, [value]) : undefined;
    if (outputKey) {
      block(id, title, value[outputKey] || "（空输出）", { facts });
      block(`${id}-stderr`, "标准错误输出", value.stderr, { error: true });
      block(`${id}-error`, "错误", value.error, { error: true });
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => ![outputKey, "stderr", "error", "exit_code", "wall_time_seconds", "duration_ms", "status", "success"].includes(key)));
      if (Object.keys(rest).length) block(`${id}-extra`, "输出附加字段", rest, { secondary: true });
    } else {
      // Output blocks with text only are readable without JSON scaffolding;
      // mixed media/unknown blocks remain JSON so nothing disappears.
      const textOnly = Array.isArray(output) && output.length > 0 && output.every(v => typeof v === "string" || (Object.keys(object(v)).every(k => ["type", "text"].includes(k)) && typeof object(v).text === "string"));
      block(id, title, textOnly ? output.map(v => typeof v === "string" ? v : object(v).text).join("\n") : output === "" || output == null ? "（空输出）" : output, { facts });
    }
  };
  block("error", "错误", p.error, { error: true });
  if (event.kind === "tool") {
    inputs(detail);
    if (result !== undefined && result !== null) outputs(detail, "output", "执行结果", false);
    for (const related of detail.related.filter(r => r.event.kind === "result")) outputs(related, `related-${related.event.id}`, "关联结果", true);
  } else if (event.kind === "result") {
    outputs(detail, "output", "输出", false);
    for (const related of detail.related.filter(r => r.event.kind === "tool")) inputs(related, `related-${related.event.id}-`, true);
  } else if (event.kind === "model") {
    const usage = Object.assign({}, ...sources.slice().reverse().map(s => object(parseContainer(s.usage ?? s.token_usage)))) as ObjectValue;
    const keys: [string, string][] = [["input_tokens", "输入 token"], ["cached_input_tokens", "缓存输入 token"], ["output_tokens", "输出 token"], ["reasoning_output_tokens", "推理输出 token"], ["total_tokens", "合计 token"]];
    for (const [key, label] of keys) if (typeof usage[key] === "number") model.facts.push({ label, value: String(usage[key]) });
    const remaining = Object.fromEntries(Object.entries(usage).filter(([key]) => !keys.some(([k]) => k === key)));
    if (Object.keys(remaining).length) block("usage-extra", "其他用量字段", remaining, { secondary: true });
    if (!model.facts.length) block("model-note", "记录", data.content);
  } else if (["user", "assistant", "summary", "system"].includes(event.kind)) {
    block("message", event.kind === "summary" ? "公开摘要" : "正文", data.content, { format: "markdown", text: data.content });
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
