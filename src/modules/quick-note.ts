import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  capsule,
  journalCancel,
  journalComposer,
  journalInput,
  journalKindNote,
  journalKindTodo,
  journalSave,
  journalSummary,
} from "../dom";
import { setUserChosenView } from "../state";
import { showNotice } from "./notice-queue";
import { setView } from "./view-switcher";

type ObsidianSettings = {
  obsidian_vault_path?: string;
  obsidian_daily_notes_dir?: string;
};

type EntryKind = "note" | "todo";

let entryKind: EntryKind = "note";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function dateParts(): { date: string; time: string } {
  const now = new Date();
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

function renderTodos(items: string[]): void {
  journalSummary.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "journal-empty";
    empty.textContent = "无待办事项";
    journalSummary.appendChild(empty);
    return;
  }

  const visible = items.length > 3 ? items.slice(0, 2) : items.slice(0, 3);
  for (const item of visible) {
    const row = document.createElement("div");
    row.className = "journal-todo-row";
    const marker = document.createElement("span");
    marker.className = "journal-todo-marker";
    const text = document.createElement("span");
    text.className = "journal-todo-text";
    text.textContent = item;
    row.append(marker, text);
    journalSummary.appendChild(row);
  }
  if (items.length > 3) {
    const more = document.createElement("div");
    more.className = "journal-more";
    more.textContent = `+${items.length - 2}`;
    journalSummary.appendChild(more);
  }
}

async function refreshTodos(): Promise<void> {
  try {
    const settings = await invoke<ObsidianSettings>("get_settings");
    if (!settings.obsidian_vault_path?.trim()) {
      renderTodos([]);
      return;
    }
    const { date } = dateParts();
    const items = await invoke<string[]>("get_obsidian_todos", {
      vaultPath: settings.obsidian_vault_path,
      dailyNotesDir: settings.obsidian_daily_notes_dir ?? "Daily",
      date,
    });
    renderTodos(items);
  } catch (error) {
    console.warn("Failed to read Obsidian todos", error);
    renderTodos([]);
  }
}

function selectKind(kind: EntryKind): void {
  entryKind = kind;
  journalKindNote.classList.toggle("active", kind === "note");
  journalKindTodo.classList.toggle("active", kind === "todo");
  journalInput.placeholder = kind === "todo" ? "添加一项今日待办…" : "记录此刻的想法…";
}

async function closeJournal(): Promise<void> {
  journalInput.value = "";
  await invoke("set_interacting", { active: false });
  await invoke("dismiss_island");
}

async function openJournal(): Promise<void> {
  const settings = await invoke<ObsidianSettings>("get_settings");
  if (!settings.obsidian_vault_path?.trim()) {
    showNotice("请先在设置中填写 Obsidian Vault 路径", "attention");
    return;
  }
  setUserChosenView("journal");
  setView("journal", true);
  capsule.classList.add("expanded");
  await invoke("set_interacting", { active: true });
  window.setTimeout(() => journalInput.focus(), 80);
}

async function saveEntry(): Promise<void> {
  const content = journalInput.value.trim();
  if (!content) return;
  journalSave.disabled = true;
  try {
    const settings = await invoke<ObsidianSettings>("get_settings");
    const { date, time } = dateParts();
    await invoke("append_obsidian_entry", {
      vaultPath: settings.obsidian_vault_path ?? "",
      dailyNotesDir: settings.obsidian_daily_notes_dir ?? "Daily",
      date,
      time,
      content,
      kind: entryKind,
    });
    journalInput.value = "";
    await refreshTodos();
    await closeJournal();
    showNotice(entryKind === "todo" ? "待办已写入 Obsidian" : "记录已写入 Obsidian", "success");
  } catch (error) {
    console.error(error);
    journalInput.classList.add("input-error");
    journalInput.title = String(error);
    window.setTimeout(() => journalInput.classList.remove("input-error"), 1800);
  } finally {
    journalSave.disabled = false;
  }
}

export function initQuickNote(): void {
  selectKind("note");
  void refreshTodos();
  window.setInterval(() => void refreshTodos(), 15_000);

  void listen<string>("context-menu-action", (event) => {
    if (event.payload === "quick-note") void openJournal();
  });
  journalKindNote.addEventListener("click", () => selectKind("note"));
  journalKindTodo.addEventListener("click", () => selectKind("todo"));
  journalComposer.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEntry();
  });
  journalCancel.addEventListener("click", () => void closeJournal());
  journalComposer.addEventListener("click", (event) => event.stopPropagation());
  journalInput.addEventListener("focus", () => void invoke("set_interacting", { active: true }));
  journalInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void closeJournal();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveEntry();
    }
  });
}
