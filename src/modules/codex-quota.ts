import { invoke } from "@tauri-apps/api/core";
import { codexQuotaLabel, codexQuotaProgress, codexQuotaRing } from "../dom";

type CodexQuota = {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  message: string | null;
};

const CIRCUMFERENCE = 2 * Math.PI * 7.5;
const CACHE_KEY = "wisland.codexQuota.v1";
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let lastSuccessfulQuota: CodexQuota | null = null;

function windowLabel(minutes: number | null): string {
  if (!minutes) return "当前窗口";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080} 周窗口`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

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

function render(quota: CodexQuota, stale = false): void {
  const remaining = quota.remainingPercent;
  if (!quota.available || remaining === null) {
    codexQuotaRing.classList.add("quota-unknown");
    codexQuotaRing.classList.remove("quota-stale");
    codexQuotaProgress.style.strokeDashoffset = String(CIRCUMFERENCE);
    codexQuotaRing.title = "Codex 剩余额度未知；需要可调用的独立 Codex CLI";
    codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
    codexQuotaLabel.textContent = "--%";
    return;
  }

  const normalized = Math.max(0, Math.min(100, remaining));
  codexQuotaRing.classList.remove("quota-unknown");
  codexQuotaRing.classList.toggle("quota-stale", stale);
  codexQuotaProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - normalized / 100));
  const reset = quota.resetsAt
    ? `，${new Date(quota.resetsAt * 1000).toLocaleString()} 重置`
    : "";
  const freshness = stale ? " · 上次成功数据，正在等待连接恢复" : "";
  codexQuotaRing.title = `Codex 剩余 ${Math.round(normalized)}% · ${windowLabel(quota.windowDurationMins)}${reset}${freshness}`;
  codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
  codexQuotaLabel.textContent = `${Math.round(normalized)}%`;
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
