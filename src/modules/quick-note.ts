import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule, quickNoteArea, quickNoteCancel, quickNoteInput, quickNoteSave } from "../dom";
import { showNotice } from "./notice-queue";

type ObsidianSettings = {
  obsidian_vault_path?: string;
  obsidian_daily_notes_dir?: string;
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

async function closeQuickNote(): Promise<void> {
  quickNoteArea.classList.remove("active");
  capsule.classList.remove("expanded", "note-active");
  quickNoteInput.value = "";
  await invoke("dismiss_island");
}

async function openQuickNote(): Promise<void> {
  const settings = await invoke<ObsidianSettings>("get_settings");
  if (!settings.obsidian_vault_path?.trim()) {
    showNotice("请先在设置中填写 Obsidian Vault 路径", "attention");
    return;
  }
  capsule.classList.add("expanded", "note-active");
  quickNoteArea.classList.add("active");
  await invoke("set_interacting", { active: true });
  window.setTimeout(() => quickNoteInput.focus(), 60);
}

async function saveQuickNote(): Promise<void> {
  const content = quickNoteInput.value.trim();
  if (!content) return;
  quickNoteSave.disabled = true;
  try {
    const settings = await invoke<ObsidianSettings>("get_settings");
    const now = new Date();
    await invoke("append_obsidian_note", {
      vaultPath: settings.obsidian_vault_path ?? "",
      dailyNotesDir: settings.obsidian_daily_notes_dir ?? "Daily",
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      content,
    });
    await closeQuickNote();
    showNotice("已写入 Obsidian", "success");
  } catch (error) {
    console.error(error);
    const originalLabel = quickNoteSave.textContent;
    quickNoteSave.textContent = "失败";
    quickNoteInput.title = String(error);
    quickNoteInput.classList.add("input-error");
    window.setTimeout(() => {
      quickNoteSave.textContent = originalLabel;
      quickNoteInput.classList.remove("input-error");
    }, 1800);
  } finally {
    quickNoteSave.disabled = false;
  }
}

export function initQuickNote(): void {
  void listen<string>("context-menu-action", (event) => {
    if (event.payload === "quick-note") void openQuickNote();
  });
  quickNoteArea.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveQuickNote();
  });
  quickNoteCancel.addEventListener("click", () => void closeQuickNote());
  quickNoteArea.addEventListener("click", (event) => event.stopPropagation());
  quickNoteInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void closeQuickNote();
  });
}
