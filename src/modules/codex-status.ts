import { invoke } from "@tauri-apps/api/core";
import { codexStatusDot } from "../dom";

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
      break;
    case "completed":
    case "idle":
      codexStatusDot.classList.add("status-idle");
      codexStatusDot.title = status.phase === "completed" ? "Codex 任务已完成" : "Codex 空闲";
      break;
    case "failed":
    case "stale":
    default:
      codexStatusDot.classList.add("status-special");
      codexStatusDot.title = status.phase === "failed" ? "Codex 状态异常" : "Codex 离线或状态未知";
  }
  codexStatusDot.setAttribute("aria-label", codexStatusDot.title);
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
  window.setInterval(() => void refresh(), 500);
}
