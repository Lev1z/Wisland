import { invoke } from "@tauri-apps/api/core";
import {
  codexQuotaFiveHourProgress,
  codexQuotaLabel,
  codexQuotaRing,
  codexQuotaWeeklyProgress,
} from "../dom";

type CodexQuotaWindow = {
  remainingPercent: number;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type CodexQuota = {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  fiveHour: CodexQuotaWindow | null;
  weekly: CodexQuotaWindow | null;
  message: string | null;
};

const WEEKLY_CIRCUMFERENCE = 2 * Math.PI * 8;
const FIVE_HOUR_CIRCUMFERENCE = 2 * Math.PI * 5;
const CACHE_KEY = "wisland.codexQuota.v2";
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let lastSuccessfulQuota: CodexQuota | null = null;

function cachedQuota(): CodexQuota | null {
  if (lastSuccessfulQuota) return lastSuccessfulQuota;
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { quota?: CodexQuota; savedAt?: number } | null;
    if (!value?.quota?.available || !value.savedAt || Date.now() - value.savedAt > CACHE_MAX_AGE_MS) return null;
    lastSuccessfulQuota = value.quota;
    return value.quota;
  } catch {
    return null;
  }
}

function remember(quota: CodexQuota): void {
  lastSuccessfulQuota = quota;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ quota, savedAt: Date.now() }));
  } catch {
    // 无可用持久存储时，当前进程内缓存仍然有效。
  }
}

function renderWindow(
  progress: SVGCircleElement,
  window: CodexQuotaWindow | null,
  circumference: number,
): void {
  if (!window) {
    progress.style.strokeDashoffset = String(circumference);
    progress.style.opacity = "0";
    return;
  }
  const remaining = Math.max(0, Math.min(100, window.remainingPercent));
  progress.style.strokeDashoffset = String(circumference * (1 - remaining / 100));
  progress.style.opacity = "";
}

function quotaDescription(label: string, window: CodexQuotaWindow | null): string {
  if (!window) return `${label}额度不可用`;
  const reset = window.resetsAt
    ? `，${new Date(window.resetsAt * 1000).toLocaleString()} 重置`
    : "";
  return `${label}剩余 ${Math.round(window.remainingPercent)}%${reset}`;
}

function percentLabel(window: CodexQuotaWindow | null): string {
  return window ? `${Math.round(window.remainingPercent)}%` : "--%";
}

function render(quota: CodexQuota, stale = false): void {
  const remaining = quota.remainingPercent;
  if (!quota.available || remaining === null) {
    codexQuotaRing.classList.add("quota-unknown");
    codexQuotaRing.classList.remove("quota-stale");
    renderWindow(codexQuotaWeeklyProgress, null, WEEKLY_CIRCUMFERENCE);
    renderWindow(codexQuotaFiveHourProgress, null, FIVE_HOUR_CIRCUMFERENCE);
    codexQuotaRing.title = "Codex 剩余额度未知；需要可调用的独立 Codex CLI";
    codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
    codexQuotaLabel.textContent = "1week: --% - 5h: --%";
    return;
  }

  codexQuotaRing.classList.remove("quota-unknown");
  codexQuotaRing.classList.toggle("quota-stale", stale);
  renderWindow(codexQuotaWeeklyProgress, quota.weekly, WEEKLY_CIRCUMFERENCE);
  renderWindow(codexQuotaFiveHourProgress, quota.fiveHour, FIVE_HOUR_CIRCUMFERENCE);
  const freshness = stale ? " · 上次成功数据，正在等待连接恢复" : "";
  codexQuotaRing.title = `Codex 额度 · 外环${quotaDescription("一周", quota.weekly)} · 内环${quotaDescription("5 小时", quota.fiveHour)}${freshness}`;
  codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
  codexQuotaLabel.textContent = `1week: ${percentLabel(quota.weekly)} - 5h: ${percentLabel(quota.fiveHour)}`;
}

async function refresh(): Promise<void> {
  try {
    const quota = await invoke<CodexQuota>("get_codex_quota");
    if (quota.available && quota.remainingPercent !== null) {
      remember(quota);
      render(quota);
      return;
    }
    const cached = cachedQuota();
    render(cached ?? quota, !!cached);
  } catch (error) {
    console.warn("Failed to read Codex quota", error);
    const unavailable: CodexQuota = {
      available: false,
      remainingPercent: null,
      usedPercent: null,
      windowDurationMins: null,
      resetsAt: null,
      fiveHour: null,
      weekly: null,
      message: String(error),
    };
    const cached = cachedQuota();
    render(cached ?? unavailable, !!cached);
  }
}

export function initCodexQuota(): void {
  const cached = cachedQuota();
  if (cached) render(cached, true);
  void invoke<boolean>("get_environment_check_active")
    .then((checking) => { if (!checking) void refresh(); })
    .catch(() => void refresh());
  window.addEventListener("wisland-environment-check-finished", () => void refresh());
  window.setInterval(() => {
    if (!document.getElementById("island-capsule")?.classList.contains("environment-check")) void refresh();
  }, 120_000);
}
