import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type RuntimeEvent = {
  id: string; turnId: string; turnNumber: number | null;
  modelCall: { responseId: string; number: number } | null; kind: string; summary: string;
  timestamp: string | null; sourceType: string; callId: string | null; status: string | null;
};
type Snapshot = {
  revision: number; sessionId: string | null; automatic: boolean;
  sessions: { id: string; label: string; modified: number; threadId?: string | null; fileName?: string }[];
  events: RuntimeEvent[]; turnStatus: Record<string, string>; notice: string; error: string | null;
};
type EventDetail = {
  event: RuntimeEvent;
  detail: { raw: { payload?: Record<string, unknown> }; mirror?: { payload?: Record<string, unknown> }; content: string; byteOffset: number };
  related: { event: RuntimeEvent; detail: EventDetail["detail"] }[];
};
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const list = el("trajectory-list");
const inspector = el("inspector");
const sessionSelect = el<HTMLSelectElement>("runtime-session");
const kinds: Record<string, string> = {
  user: "用户", assistant: "助手", summary: "摘要", tool: "工具", result: "结果",
  compaction: "压缩", lifecycle: "回合", error: "异常", context: "背景", system: "系统", model: "模型",
};
const statuses: Record<string, string> = { started: "已开始", completed: "Completed", aborted: "Interrupted", failed: "Failed" };
let state: Snapshot | null = null;
let following = true;
let selected: string | null = null;
let detail: EventDetail | null = null;
let tab: "overview" | "raw" = "overview";
let requestSerial = 0;
let restoreAuto = false;
let savedScroll = 0;
let returnFocus: string | null = null;
let sessionOptionsKey = "";
let renderingList = false;
let inspectorPhase: "closed" | "opening" | "open" | "closing" = "closed";
let transitionSerial = 0;
let navigationSerial = 0;
let paneAnimations: Animation[] = [];
let pinPromise: Promise<Snapshot> | null = null;
let followAfterClose = false;
const inspectorCard = inspector.querySelector<HTMLElement>(".inspector-card")!;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function motionEnabled(): boolean {
  return document.documentElement.dataset.motion !== "false" && !reducedMotion.matches;
}
function resetInspector(): void {
  transitionSerial++;
  paneAnimations.forEach(animation => animation.cancel()); paneAnimations = [];
  inspectorPhase = "closed"; inspector.hidden = true; inspector.inert = false;
  inspector.dataset.phase = "closed"; followAfterClose = false;
  inspector.style.transform = ""; inspectorCard.style.opacity = "";
  updateSelection();
}
function transitionInspector(open: boolean, complete: () => void = () => {}): void {
  const fresh = inspectorPhase === "closed";
  const transform = fresh ? "translateX(100%)" : getComputedStyle(inspector).transform;
  const opacity = fresh ? "0" : getComputedStyle(inspectorCard).opacity;
  const serial = ++transitionSerial;
  paneAnimations.forEach(animation => animation.cancel()); paneAnimations = [];
  inspectorPhase = open ? "opening" : "closing";
  inspector.dataset.phase = inspectorPhase;
  inspector.hidden = false; inspector.inert = !open;
  const finish = (): void => {
    if (serial !== transitionSerial) return;
    inspector.style.transform = open ? "none" : "translateX(100%)";
    inspectorCard.style.opacity = open ? "1" : "0";
    paneAnimations.forEach(animation => animation.cancel()); paneAnimations = [];
    inspectorPhase = open ? "open" : "closed";
    inspector.dataset.phase = inspectorPhase;
    inspector.hidden = !open; inspector.inert = false;
    complete();
  };
  if (!motionEnabled()) { finish(); return; }
  const duration = open ? 300 : 220;
  const timing: KeyframeAnimationOptions = { duration, easing: open ? "cubic-bezier(.2,.75,.25,1)" : "cubic-bezier(.4,0,.7,.2)", fill: "both" };
  paneAnimations = [
    inspector.animate([{ transform }, { transform: open ? "translateX(0)" : "translateX(100%)" }], timing),
    inspectorCard.animate([{ opacity }, { opacity: open ? 1 : 0 }], { ...timing, delay: open && fresh ? 35 : 0, duration: duration - (open && fresh ? 35 : 0) }),
  ];
  void Promise.all(paneAnimations.map(animation => animation.finished.catch(() => {}))).then(finish);
}

function renderSessionOptions(snapshot: Snapshot): void {
  const current = snapshot.sessions.find(s => s.id === snapshot.sessionId);
  const optionsKey = JSON.stringify([snapshot.sessionId, snapshot.sessions.map(s => [s.id, s.label])]);
  if (document.activeElement !== sessionSelect) {
    if (sessionOptionsKey !== optionsKey) {
      sessionSelect.replaceChildren(new Option(current ? `自动 · ${current.label}` : "自动 · 最近活跃", ""), ...snapshot.sessions.map(s => new Option(`${s.label}${s.threadId ? ` · ${s.threadId.slice(0, 8)}` : ""}`, s.id)));
      sessionOptionsKey = optionsKey;
    }
    sessionSelect.value = snapshot.automatic ? "" : snapshot.sessionId ?? "";
  }
  sessionSelect.title = current ? `${current.label}\n${current.fileName ?? current.id}` : "尚未发现会话";
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
function button(className: string, text: string, action: () => void): HTMLButtonElement {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}
function setFollowing(value: boolean): void {
  following = value;
  el("follow").textContent = value ? "Live ↓" : "跟随 ↓";
  el("follow").setAttribute("aria-pressed", String(value));
}
function turnLabel(event: RuntimeEvent): string {
  return event.turnNumber == null ? "未关联" : `第${event.turnNumber}轮`;
}
function renderList(): void {
  if (!state) return;
  renderingList = true;
  const previousTop = list.scrollTop;
  // Anchor a visible event, including when the bounded history evicts old rows.
  const top = list.getBoundingClientRect().top;
  const anchor = [...list.querySelectorAll<HTMLElement>(".event-row")].find(e => e.getBoundingClientRect().top >= top);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const focused = (document.activeElement as HTMLElement)?.dataset.event;
  const existing = new Map([...list.querySelectorAll<HTMLButtonElement>(".event-row")].map(row => [row.dataset.event!, row]));
  const rows: HTMLButtonElement[] = [];
  let previousTurn: string | null = null;
  // File order is the timeline order: never move a delayed result back beside
  // its tool call. call_id association remains available inside Inspector.
  for (const event of state.events) {
    const row = existing.get(event.id) ?? button("event-row", "", () => void openEvent(event.id));
    const firstInTurn = event.turnId !== previousTurn;
    row.dataset.event = event.id;
    row.dataset.kind = event.kind;
    row.dataset.turnStart = String(firstInTurn);
    const status = statuses[state.turnStatus[event.turnId]] ?? "未记录结束状态";
    row.title = `${turnLabel(event)} · ${status}\n${kinds[event.kind] ?? "记录"} · ${event.summary}`;
    const renderKey = JSON.stringify([event, firstInTurn]);
    if (row.dataset.renderKey !== renderKey) {
      const gutter = node("span", "timeline-gutter");
      if (firstInTurn) gutter.append(node("span", "timeline-turn", turnLabel(event)));
      if (event.modelCall) {
        row.dataset.modelCall = event.modelCall.responseId;
        const marker = node("span", "request-marker", `#${event.modelCall.number}`);
        marker.title = `模型调用 #${event.modelCall.number} 完成\nresponse_id: ${event.modelCall.responseId}\n此处为完成记录，未推算请求起点或耗时`;
        marker.setAttribute("aria-label", marker.title);
        gutter.append(marker);
      } else { delete row.dataset.modelCall; }
      row.replaceChildren(gutter, node("i", "event-color"), node("span", "event-kind", kinds[event.kind] ?? "记录"), node("span", "event-summary", event.summary || "（空内容）"));
      row.dataset.renderKey = renderKey;
    }
    rows.push(row);
    previousTurn = event.turnId;
  }
  // Reconcile in place: the exposed timeline IS the Inspector navigation.
  // Pinning a session or appending a record must not replace/reparent its rows.
  let cursor = list.firstElementChild;
  for (const row of rows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
  if (!rows.length) list.append(node("p", "runtime-empty", state.sessionId ? "等待这份日志写入可展示的事件…" : "暂无本地轨迹\n开始一轮 Codex 对话后，这里会自动更新。"));
  updateSelection();
  if (following && !selected) { list.scrollTop = list.scrollHeight; }
  else {
    const next = anchor && [...list.querySelectorAll<HTMLElement>(".event-row")].find(e => e.dataset.event === anchor.dataset.event);
    list.scrollTop = previousTop;
    if (next) list.scrollTop += next.getBoundingClientRect().top - top - anchorOffset;
  }
  if (focused && !selected) [...list.querySelectorAll<HTMLElement>(".event-row")].find(e => e.dataset.event === focused)?.focus({ preventScroll: true });
  requestAnimationFrame(() => { renderingList = false; });
}

function accept(snapshot: Snapshot): void {
  if (!snapshot || (state && snapshot.revision < state.revision)) return;
  const switched = state?.sessionId !== snapshot.sessionId;
  if (switched) {
    selected = null; detail = null; restoreAuto = false; navigationSerial++; resetInspector();
    setFollowing(true); requestSerial++;
  }
  state = snapshot;
  // Do not rebuild an open native select while a streaming log changes its mtime.
  renderSessionOptions(snapshot);
  el("runtime-notice").textContent = snapshot.error ?? snapshot.notice;
  renderList();
  if (selected && inspectorPhase !== "closing") { void loadDetail(selected, false); }
}

function updateSelection(): void {
  for (const row of list.querySelectorAll<HTMLElement>(".event-row")) {
    row.setAttribute("aria-current", String(row.dataset.event === selected));
  }
}
async function openEvent(id: string): Promise<void> {
  if (!state?.sessionId) return;
  const serial = ++navigationSerial;
  followAfterClose = false;
  const sessionId = state.sessionId;
  const fresh = inspectorPhase === "closed";
  if (fresh) {
    savedScroll = list.scrollTop; returnFocus = id;
    // Reading details pauses scrolling as well as automatic session switching.
    // Otherwise a live append can jump the list on the first snapshot after close.
    setFollowing(false);
    // Freeze session selection while inspecting; auto-follow is restored on close.
    restoreAuto = state.automatic;
    pinPromise = restoreAuto ? invoke<Snapshot>("select_runtime_session", { id: sessionId }) : null;
  }
  const opening = fresh || inspectorPhase === "closing";
  selected = id; detail = null; requestSerial++;
  const event = state.events.find(e => e.id === id);
  el("inspector-title").textContent = event ? `${kinds[event.kind] ?? "记录"} · ${event.summary}` : "事件详情";
  el("inspector-content").textContent = "正在读取…";
  if (opening) transitionInspector(true);
  updateSelection();
  el("close-inspector").focus({ preventScroll: true });
  if (fresh && pinPromise) {
    try {
      const snapshot = await pinPromise;
      if (serial !== navigationSerial || selected !== id) return;
      accept(snapshot);
    } catch (error) {
      if (serial === navigationSerial) el("runtime-notice").textContent = String(error);
    }
  }
  if (serial !== navigationSerial || state?.sessionId !== sessionId) return;
  await loadDetail(id, true);
}
async function loadDetail(id: string, reset: boolean): Promise<void> {
  const serial = ++requestSerial;
  try {
    const next = await invoke<EventDetail>("get_runtime_event", { sessionId: state?.sessionId, id });
    if (serial !== requestSerial || selected !== id) return;
    const changed = JSON.stringify(next) !== JSON.stringify(detail);
    detail = next;
    if (changed || reset) renderDetail(reset);
  } catch (error) {
    if (serial === requestSerial) el("inspector-content").textContent = String(error);
  }
}
function renderDetail(reset: boolean): void {
  if (!detail) return;
  const content = el("inspector-content");
  const scroll = content.scrollTop;
  const { event, detail: data } = detail;
  el("inspector-title").textContent = `${kinds[event.kind] ?? "记录"} · ${event.summary || event.sourceType}`;
  el("inspector-title").dataset.kind = event.kind;
  el("tab-overview").setAttribute("aria-selected", String(tab === "overview"));
  el("tab-raw").setAttribute("aria-selected", String(tab === "raw"));
  const sections: HTMLElement[] = [];
  const section = (title: string, value: unknown): void => {
    if (value === undefined || value === null || value === "") return;
    const block = node("section", "detail-section");
    block.append(node("h4", "", title), node("pre", "", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    sections.push(block);
  };
  if (tab === "raw") {
    section("JSONL 记录（限长；二进制 / 加密字段省略）", data.raw);
    section("同一消息的另一条源记录（已合并显示）", data.mirror);
  } else {
    section("内容", data.content);
    const envelope = data.raw.payload ?? {};
    const p = (envelope.item as Record<string, unknown>) ?? envelope;
    section("工具参数", p.arguments ?? p.input ?? p.action ?? p.command);
    section("执行结果", p.output ?? p.aggregated_output ?? p.content_items ?? p.result);
    for (const related of detail.related) {
      const rp = related.detail.raw.payload ?? {};
      section(related.event.kind === "result" ? "关联结果 · call_id" : "关联工具 · call_id", rp.output ?? rp.arguments ?? rp.input ?? related.detail.content);
    }
    const metadata: Record<string, unknown> = { source: event.sourceType, timestamp: event.timestamp, turn_id: event.turnId === "unattributed" ? undefined : event.turnId, response_id: event.modelCall?.responseId, call_id: event.callId, status: event.status, byte_offset: data.byteOffset };
    for (const key of ["duration", "duration_ms", "started_at", "completed_at", "exit_code", "model", "phase", "usage", "token_usage", "error", "success"]) if (p[key] !== undefined) metadata[key] = p[key];
    for (const key of ["started_at_ms", "completed_at_ms", "thread_id"]) if (envelope[key] !== undefined) metadata[key] = envelope[key];
    if (data.mirror) metadata.mirrored_record = data.mirror.payload;
    section("可用元数据", Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== null && v !== undefined)));
  }
  content.replaceChildren(...sections);
  content.scrollTop = reset ? 0 : scroll;
}
export function closeInspector(): boolean {
  if (inspectorPhase === "closed") return false;
  if (inspectorPhase === "closing") return true;
  const serial = ++navigationSerial;
  requestSerial++;
  transitionInspector(false, () => {
    selected = null; detail = null;
    updateSelection();
    // Preserve the list throughout the transition; hide the overlay only at its end.
    if (followAfterClose) { setFollowing(true); list.scrollTop = list.scrollHeight; }
    else { list.scrollTop = savedScroll; }
    followAfterClose = false;
    [...list.querySelectorAll<HTMLElement>(".event-row")].find(e => e.dataset.event === returnFocus)?.focus({ preventScroll: true });
    const automatic = restoreAuto; restoreAuto = false;
    if (automatic) void (async () => {
      await pinPromise?.catch(() => {});
      if (serial !== navigationSerial) return;
      const snapshot = await invoke<Snapshot>("select_runtime_session", { id: null });
      if (serial === navigationSerial) accept(snapshot);
    })().catch(error => { el("runtime-notice").textContent = String(error); });
  });
  return true;
}

export async function initRuntime(): Promise<void> {
  const settleReducedMotion = (): void => { if (!motionEnabled()) paneAnimations.forEach(animation => animation.finish()); };
  reducedMotion.addEventListener("change", settleReducedMotion);
  new MutationObserver(settleReducedMotion).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  sessionSelect.addEventListener("blur", () => { if (state) renderSessionOptions(state); });
  list.addEventListener("scroll", () => {
    if (!selected && !renderingList) setFollowing(list.scrollHeight - list.scrollTop - list.clientHeight < 24);
  });
  el("follow").addEventListener("click", () => {
    if (inspectorPhase !== "closed") { followAfterClose = true; closeInspector(); }
    else { setFollowing(true); list.scrollTop = list.scrollHeight; }
  });
  sessionSelect.addEventListener("change", async () => {
    restoreAuto = false; selected = null; navigationSerial++; requestSerial++; resetInspector();
    try { accept(await invoke<Snapshot>("select_runtime_session", { id: sessionSelect.value || null })); }
    catch (error) { el("runtime-notice").textContent = String(error); }
  });
  el("close-inspector").addEventListener("click", closeInspector);
  for (const name of ["overview", "raw"] as const) el(`tab-${name}`).addEventListener("click", () => { tab = name; renderDetail(true); });
  await listen<Snapshot>("runtime-snapshot", ({ payload }) => accept(payload));
  accept(await invoke<Snapshot>("get_runtime_snapshot"));
}
