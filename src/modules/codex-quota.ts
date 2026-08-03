import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

function windowLabel(minutes: number | null): string {
  if (!minutes) return "当前窗口";
  if (minutes >= 10080 && minutes % 10080 === 0) return `${minutes / 10080} 周窗口`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

function render(quota: CodexQuota): void {
  const remaining = quota.remainingPercent;
  if (!quota.available || remaining === null) {
    codexQuotaRing.classList.add("quota-unknown");
    codexQuotaProgress.style.strokeDashoffset = String(CIRCUMFERENCE);
    codexQuotaRing.title = quota.message || "Codex 剩余额度未知；可在启动检查或设置中连接";
    codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
    codexQuotaLabel.textContent = "--%";
    return;
  }

  const normalized = Math.max(0, Math.min(100, remaining));
  codexQuotaRing.classList.remove("quota-unknown");
  codexQuotaProgress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - normalized / 100));
  const reset = quota.resetsAt
    ? `，${new Date(quota.resetsAt * 1000).toLocaleString()} 重置`
    : "";
  codexQuotaRing.title = `Codex 剩余 ${Math.round(normalized)}% · ${windowLabel(quota.windowDurationMins)}${reset}`;
  codexQuotaRing.setAttribute("aria-label", codexQuotaRing.title);
  codexQuotaLabel.textContent = `${Math.round(normalized)}%`;
}

async function refresh(): Promise<void> {
  try {
    render(await invoke<CodexQuota>("get_codex_quota"));
  } catch (error) {
    console.warn("Failed to read Codex quota", error);
    render({
      available: false,
      remainingPercent: null,
      usedPercent: null,
      windowDurationMins: null,
      resetsAt: null,
      message: String(error),
    });
  }
}

export function initCodexQuota(): void {
  void refresh();
  window.setInterval(() => void refresh(), 120_000);
  void listen("onboarding-complete", () => void refresh());
}
