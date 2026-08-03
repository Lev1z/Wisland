import { invoke } from "@tauri-apps/api/core";
import { codexStatusDot, codexStatusLabel } from "../dom";
import { applyIndicatorStatus } from "./minimize-drag";

type CodexPhase = "idle" | "running" | "completed" | "failed" | "stale";

type CodexStatus = {
  phase: CodexPhase;
  updatedAt: number;
  statusPath: string;
};

let lastPhase: CodexPhase | null = null;

function render(status: CodexStatus): void {
  codexStatusDot.classList.remove("status-idle", "status-running", "status-special");
  switch (status.phase) {
    case "running":
      codexStatusDot.classList.add("status-running");
      codexStatusDot.title = "Codex 正在执行任务";
      codexStatusLabel.textContent = "工作";
      break;
    case "completed":
    case "idle":
      codexStatusDot.classList.add("status-idle");
      codexStatusDot.title = status.phase === "completed" ? "Codex 任务已完成" : "Codex 空闲";
      codexStatusLabel.textContent = status.phase === "completed" ? "完成" : "空闲";
      break;
    case "failed":
    case "stale":
    default:
      codexStatusDot.classList.add("status-special");
      codexStatusDot.title = status.phase === "failed" ? "Codex 状态异常" : "Codex 离线或状态未知";
      codexStatusLabel.textContent = status.phase === "failed" ? "异常" : "离线";
  }
  codexStatusDot.setAttribute("aria-label", codexStatusDot.title);
  applyIndicatorStatus(status.phase, status.updatedAt > 0);
  lastPhase = status.phase;
}

async function refresh(): Promise<void> {
  try {
    render(await invoke<CodexStatus>("get_codex_status"));
  } catch (error) {
    if (lastPhase !== "idle") console.warn("Failed to read Codex status", error);
    render({ phase: "idle", updatedAt: 0, statusPath: "" });
  }
}

export function initCodexStatus(): void {
  void refresh();
  // 状态文件不会以亚秒级变化；降低 IPC 频率可减少常驻内存和 CPU 压力。
  window.setInterval(() => void refresh(), 2_000);
}
