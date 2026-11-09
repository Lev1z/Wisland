import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SessionPicker } from "./session-picker";
import { buildSessionOptions, type RuntimeSession } from "./session-options";
import { associationNames, type EventDetail, type RuntimeEvent } from "./runtime-detail";
import { detailTitle, renderDetailContent } from "./runtime-detail-view";
type Snapshot = {
  revision: number; sessionId: string | null; automatic: boolean;
  sessions: RuntimeSession[];
  events: RuntimeEvent[]; turnStatus: Record<string, string>; notice: string; error: string | null;
};
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const list = el("trajectory-list");
const inspector = el("inspector");
let sessionPicker: SessionPicker;
const kinds: Record<string, string> = {
  user: "用户", assistant: "助手", summary: "思考", tool: "工具", result: "结果",
  compaction: "压缩", lifecycle: "回合", error: "异常", context: "上下文", system: "系统", model: "模型", record: "记录",
};
const kindHints: Record<string, string> = {
  summary: "思考摘要：日志公开提供的推理摘要",
  context: "上下文：环境、工具或配置相关记录",
  record: "其他记录：尚未专门分类的日志事件",
};
const statuses: Record<string, string> = { started: "已开始", completed: "Completed", aborted: "Interrupted", failed: "Failed" };
let state: Snapshot | null = null;
let following = true;
let selected: string | null = null;
let detail: EventDetail | null = null;
let disposeDetail: (() => void) | undefined;
let tab: "overview" | "raw" = "overview";
let requestSerial = 0;
let restoreAuto = false;
let savedScroll = 0;
let savedAnchor: { id: string; offset: number } | null = null;
let returnFocus: string | null = null;
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
  disposeDetail?.(); disposeDetail = undefined;
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
  const options = buildSessionOptions(snapshot.sessions, snapshot.sessionId);
  const caption = options.find(option => option.value === current?.id)?.title ?? "最近活跃";
  sessionPicker.update(options, snapshot.automatic ? "" : snapshot.sessionId ?? "",
    `${snapshot.automatic ? "自动 · " : ""}${caption}`,
    current ? `${current.label}\n${current.fileName ?? current.id}` : "尚未发现会话");
}

export function closeSessionPicker(): boolean { return sessionPicker?.close() ?? false; }

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
  // Backend supplies logical headings; underlying events still retain source
  // order. In particular, delayed tool results are never pulled backwards.
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
        marker.title = `模型 #${event.modelCall.number}\nresponse_id: ${event.modelCall.responseId}\n${associationNames[event.modelPresentation?.association ?? "unassociated"]}\n标题位置不代表请求开始时间`;
        marker.setAttribute("aria-label", marker.title);
        gutter.append(marker);
      } else { delete row.dataset.modelCall; }
      const kind = node("span", "event-kind", kinds[event.kind] ?? "记录");
      if (kindHints[event.kind]) kind.title = kindHints[event.kind];
      row.replaceChildren(gutter, node("i", "event-color"), kind, node("span", "event-summary", event.summary || "（空内容）"));
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
    if (selected && savedAnchor) {
      const returnRow = [...list.querySelectorAll<HTMLElement>(".event-row")].find(e => e.dataset.event === savedAnchor!.id);
      if (returnRow) savedScroll = list.scrollTop + returnRow.getBoundingClientRect().top - top - savedAnchor.offset;
    }
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
  // Picker labels update independently of streaming log mtimes and preserve focus.
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
    const listTop = list.getBoundingClientRect().top;
    const anchor = [...list.querySelectorAll<HTMLElement>(".event-row")].find(row => row.getBoundingClientRect().top >= listTop);
    savedAnchor = anchor ? { id: anchor.dataset.event!, offset: anchor.getBoundingClientRect().top - listTop } : null;
    // Reading details pauses scrolling as well as automatic session switching.
    // Otherwise a live append can jump the list on the first snapshot after close.
    setFollowing(false);
    // Freeze session selection while inspecting; auto-follow is restored on close.
    restoreAuto = state.automatic;
    pinPromise = restoreAuto ? invoke<Snapshot>("select_runtime_session", { id: sessionId }) : null;
  }
  const opening = fresh || inspectorPhase === "closing";
  selected = id; detail = null; requestSerial++;
  disposeDetail?.(); disposeDetail = undefined;
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
    if (serial === requestSerial) {
      disposeDetail?.(); disposeDetail = undefined;
      el("inspector-content").textContent = String(error);
    }
  }
}
function renderDetail(reset: boolean): void {
  if (!detail) return;
  const content = el("inspector-content");
  el("inspector-title").textContent = detailTitle(detail);
  el("inspector-title").title = detail.event.summary;
  el("inspector-title").dataset.kind = detail.event.kind;
  el("tab-overview").setAttribute("aria-selected", String(tab === "overview"));
  el("tab-raw").setAttribute("aria-selected", String(tab === "raw"));
  disposeDetail?.();
  disposeDetail = renderDetailContent(content, detail, tab === "raw", reset);
}
export function closeInspector(): boolean {
  if (inspectorPhase === "closed") return false;
  if (inspectorPhase === "closing") return true;
  const serial = ++navigationSerial;
  requestSerial++;
  transitionInspector(false, () => {
    selected = null; detail = null;
    disposeDetail?.(); disposeDetail = undefined;
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
  sessionPicker = new SessionPicker(value => { void (async () => {
    restoreAuto = false; selected = null; const serial = ++navigationSerial; requestSerial++; resetInspector();
    try {
      await pinPromise?.catch(() => {});
      if (serial !== navigationSerial) return;
      const snapshot = await invoke<Snapshot>("select_runtime_session", { id: value || null });
      if (serial === navigationSerial) accept(snapshot);
    } catch (error) { el("runtime-notice").textContent = String(error); }
  })(); });
  list.addEventListener("scroll", () => {
    if (!selected && !renderingList) setFollowing(list.scrollHeight - list.scrollTop - list.clientHeight < 24);
  });
  el("follow").addEventListener("click", () => {
    if (inspectorPhase !== "closed") { followAfterClose = true; closeInspector(); }
    else { setFollowing(true); list.scrollTop = list.scrollHeight; }
  });
  el("close-inspector").addEventListener("click", closeInspector);
  for (const name of ["overview", "raw"] as const) el(`tab-${name}`).addEventListener("click", () => { tab = name; renderDetail(true); });
  await listen<Snapshot>("runtime-snapshot", ({ payload }) => accept(payload));
  accept(await invoke<Snapshot>("get_runtime_snapshot"));
}
