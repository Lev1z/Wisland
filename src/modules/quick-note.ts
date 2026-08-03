import { invoke } from "@tauri-apps/api/core";
import {
  journalBrowser,
  journalBrowserNotes,
  journalBrowserTodos,
  journalCancel,
  journalComposer,
  journalEntryList,
  journalInput,
  journalKindBrowse,
  journalKindNote,
  journalKindTodo,
  journalSave,
  journalSummary,
} from "../dom";
import { showNotice } from "./notice-queue";

type ObsidianSettings = {
  obsidian_vault_path?: string;
  obsidian_daily_notes_dir?: string;
};

type EntryKind = "note" | "todo";
type ComposerMode = EntryKind | "browse";

type ObsidianEntry = {
  id: string;
  kind: EntryKind;
  text: string;
  completed: boolean;
};

let entryKind: EntryKind = "note";
let composerMode: ComposerMode = "note";
let browseKind: EntryKind = "note";
let visibleEntries: ObsidianEntry[] = [];

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

async function obsidianContext(): Promise<{
  vaultPath: string;
  dailyNotesDir: string;
  date: string;
}> {
  const settings = await invoke<ObsidianSettings>("get_settings");
  const vaultPath = settings.obsidian_vault_path?.trim() ?? "";
  if (!vaultPath) throw new Error("请先在设置中填写 Obsidian Vault 路径");
  return {
    vaultPath,
    dailyNotesDir: settings.obsidian_daily_notes_dir ?? "Daily",
    date: dateParts().date,
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
    const context = await obsidianContext();
    const items = await invoke<string[]>("get_obsidian_todos", context);
    renderTodos(items);
  } catch (error) {
    console.warn("Failed to read Obsidian todos", error);
    renderTodos([]);
  }
}

function renderEntries(): void {
  journalEntryList.replaceChildren();
  const entries = visibleEntries.filter((entry) => entry.kind === browseKind);
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "journal-browser-empty";
    empty.textContent = browseKind === "todo" ? "今天还没有待办" : "今天还没有记录";
    journalEntryList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `journal-entry ${entry.kind}${entry.completed ? " done" : ""}`;
    row.role = "listitem";
    if (entry.kind === "todo") {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.completed;
      checkbox.title = entry.completed ? "标记为未完成" : "标记为已完成";
      checkbox.addEventListener("change", () => void updateTodo(entry, checkbox.checked));
      row.appendChild(checkbox);
    }
    const text = document.createElement("span");
    text.className = "journal-entry-text";
    text.textContent = entry.text;
    text.title = entry.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "journal-entry-delete";
    remove.textContent = "×";
    remove.title = "删除";
    remove.setAttribute("aria-label", `删除${entry.kind === "todo" ? "待办" : "记录"}`);
    remove.addEventListener("click", () => void deleteEntry(entry));
    row.append(text, remove);
    journalEntryList.appendChild(row);
  }
}

async function refreshEntries(): Promise<void> {
  try {
    visibleEntries = await invoke<ObsidianEntry[]>("get_obsidian_entries", await obsidianContext());
    renderEntries();
  } catch (error) {
    visibleEntries = [];
    renderEntries();
    showNotice(String(error), "attention");
  }
}

async function updateTodo(entry: ObsidianEntry, completed: boolean): Promise<void> {
  try {
    await invoke("set_obsidian_todo_completed", {
      ...await obsidianContext(),
      id: entry.id,
      completed,
    });
    await Promise.all([refreshEntries(), refreshTodos()]);
  } catch (error) {
    showNotice(`更新待办失败：${String(error)}`, "error");
    await refreshEntries();
  }
}

async function deleteEntry(entry: ObsidianEntry): Promise<void> {
  try {
    await invoke("delete_obsidian_entry", {
      ...await obsidianContext(),
      id: entry.id,
    });
    await Promise.all([refreshEntries(), refreshTodos()]);
  } catch (error) {
    showNotice(`删除失败：${String(error)}`, "error");
  }
}

function selectKind(kind: EntryKind): void {
  entryKind = kind;
  composerMode = kind;
  journalKindNote.classList.toggle("active", kind === "note");
  journalKindTodo.classList.toggle("active", kind === "todo");
  journalKindBrowse.classList.remove("active");
  journalBrowser.hidden = true;
  journalInput.hidden = false;
  journalSave.hidden = false;
  journalInput.placeholder = kind === "todo" ? "添加一项今日待办…" : "记录此刻的想法…";
}

function selectBrowse(kind = browseKind): void {
  composerMode = "browse";
  browseKind = kind;
  journalKindNote.classList.remove("active");
  journalKindTodo.classList.remove("active");
  journalKindBrowse.classList.add("active");
  journalBrowserNotes.classList.toggle("active", kind === "note");
  journalBrowserTodos.classList.toggle("active", kind === "todo");
  journalInput.hidden = true;
  journalBrowser.hidden = false;
  journalSave.hidden = true;
  void refreshEntries();
}

async function closeJournal(): Promise<void> {
  journalInput.value = "";
  await invoke("set_interacting", { active: false });
  await invoke("dismiss_island");
}

async function saveEntry(): Promise<void> {
  if (composerMode === "browse") return;
  const content = journalInput.value.trim();
  if (!content) return;
  journalSave.disabled = true;
  try {
    const context = await obsidianContext();
    await invoke("append_obsidian_entry", {
      ...context,
      time: dateParts().time,
      content,
      kind: entryKind,
    });
    journalInput.value = "";
    await Promise.all([refreshTodos(), refreshEntries()]);
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
  window.setInterval(() => {
    void refreshTodos();
    if (composerMode === "browse") void refreshEntries();
  }, 15_000);

  journalKindNote.addEventListener("click", () => selectKind("note"));
  journalKindTodo.addEventListener("click", () => selectKind("todo"));
  journalKindBrowse.addEventListener("click", () => selectBrowse());
  journalBrowserNotes.addEventListener("click", () => selectBrowse("note"));
  journalBrowserTodos.addEventListener("click", () => selectBrowse("todo"));
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
