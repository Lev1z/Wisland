import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule, noticeArea } from "../dom";
import { userChosenView, setUserChosenView } from "../state";
import { getAvailableViews, setView } from "./view-switcher";

export type NoticeKind = "info" | "success" | "attention" | "error";

export type NoticeItem = {
  id: string;
  kind?: NoticeKind;
  message: string;
  duration?: number;
};

const queue: NoticeItem[] = [];
let active: NoticeItem | null = null;
let timer: number | null = null;
let nextId = 0;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clearTimer(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function finish(): void {
  clearTimer();
  active = null;
  noticeArea.classList.remove("active");
  noticeArea.replaceChildren();
  capsule.classList.remove("expanded", "notice-active");
  void invoke("dismiss_island");

  const views = getAvailableViews();
  const destination = views.includes(userChosenView) ? userChosenView : "time";
  if (destination === "time") setUserChosenView("time");
  setView(destination, true);
}

function showNext(): void {
  clearTimer();
  active = queue.shift() ?? null;
  if (!active) {
    finish();
    return;
  }

  const kind = active.kind ?? "info";
  noticeArea.innerHTML = `
    <div class="notice-content" data-kind="${kind}">
      <div class="notice-main">
        <div class="icon-box" aria-hidden="true">●</div>
        <div class="notice-text"><div class="notice-msg">${escapeHtml(active.message)}</div></div>
      </div>
      <button class="notice-dismiss" type="button">忽略</button>
    </div>`;
  noticeArea.classList.add("active");
  capsule.classList.add("expanded", "notice-active");
  void invoke("set_interacting", { active: true });

  noticeArea.querySelector(".notice-dismiss")?.addEventListener("click", (event) => {
    event.stopPropagation();
    showNext();
  });
  timer = window.setTimeout(showNext, Math.min(active.duration ?? 3000, 5000));
}

export function enqueueNotice(item: NoticeItem): void {
  queue.push(item);
  if (!active) showNext();
}

export function showNotice(message: string, kind: NoticeKind = "info"): void {
  enqueueNotice({ id: `notice-${++nextId}`, kind, message });
}

export function clearQueue(): void {
  queue.length = 0;
  finish();
}

export function initNoticeQueue(): void {
  noticeArea.addEventListener("click", (event) => event.stopPropagation());
  void listen<string>("show-notice", (event) => showNotice(event.payload));
  void listen("notice-timeout", () => undefined);
}
