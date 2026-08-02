import { invoke } from "@tauri-apps/api/core";

type CoreSettings = {
  lyric_mode?: string;
  lyric_offset_enabled?: boolean;
  indicator_color?: string;
  obsidian_vault_path?: string;
  obsidian_daily_notes_dir?: string;
};

type CodexStatus = {
  phase: "idle" | "running" | "completed" | "failed" | "stale";
  updatedAt: number;
  statusPath: string;
};

const pageMeta: Record<string, { title: string; description: string }> = {
  general: { title: "常规", description: "只保留日常常驻真正需要的选项。" },
  music: { title: "音乐", description: "可选的 SMTC 音乐信息与歌词。" },
  codex: { title: "Codex", description: "Codex 任务状态接入位置。" },
  obsidian: { title: "Obsidian", description: "每日笔记和快捷记录入口。" },
  behavior: { title: "行为", description: "自动隐藏、进程黑名单与诊断。" },
  about: { title: "关于", description: "Wisland 的版本和当前边界。" },
};

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing settings element: #${id}`);
  return value as T;
}

const title = element<HTMLHeadingElement>("page-title");
const description = element<HTMLParagraphElement>("page-description");
const status = element<HTMLSpanElement>("save-status");
const autoStart = element<HTMLInputElement>("auto-start");
const indicatorColor = element<HTMLInputElement>("indicator-color");
const lyricMode = element<HTMLSelectElement>("lyric-mode");
const lyricOffsetEnabled = element<HTMLInputElement>("lyric-offset-enabled");
const smtcWhitelistEnabled = element<HTMLInputElement>("smtc-whitelist-enabled");
const smtcWhitelist = element<HTMLTextAreaElement>("smtc-whitelist");
const blacklistEnabled = element<HTMLInputElement>("blacklist-enabled");
const blacklist = element<HTMLTextAreaElement>("blacklist");
const logLevel = element<HTMLSelectElement>("log-level");
const saveButton = element<HTMLButtonElement>("save-button");
const obsidianVaultPath = element<HTMLInputElement>("obsidian-vault-path");
const obsidianDailyNotesDir = element<HTMLInputElement>("obsidian-daily-notes-dir");
const codexHookState = element<HTMLSpanElement>("codex-hook-state");
const installCodexHooks = element<HTMLButtonElement>("install-codex-hooks");
const clearCodexStatus = element<HTMLButtonElement>("clear-codex-status");

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function showStatus(message: string, error = false): void {
  status.textContent = message;
  status.style.color = error ? "#ff7b88" : "#70e69a";
  window.setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
  }, 3000);
}

function renderCodexStatus(value: CodexStatus): void {
  const labels: Record<CodexStatus["phase"], string> = {
    idle: "等待首次任务",
    running: "正在运行",
    completed: "最近已完成",
    failed: "最近异常",
    stale: "状态已过期",
  };
  codexHookState.textContent = labels[value.phase];
  codexHookState.style.color = value.phase === "failed" ? "#ff7b88" : value.phase === "running" ? "#ffd66b" : "#70e69a";
}

async function refreshCodexStatus(): Promise<void> {
  renderCodexStatus(await invoke<CodexStatus>("get_codex_status"));
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".nav-item")) {
  button.addEventListener("click", () => {
    const page = button.dataset.page ?? "general";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".page").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    element<HTMLElement>(`page-${page}`).classList.add("active");
    title.textContent = pageMeta[page].title;
    description.textContent = pageMeta[page].description;
  });
}

async function loadSettings(): Promise<void> {
  try {
    const [core, startsWithWindows, blacklistOn, blocked, smtcOn, players, level] = await Promise.all([
      invoke<CoreSettings>("get_settings"),
      invoke<boolean>("get_auto_start"),
      invoke<boolean>("get_blacklist_enabled"),
      invoke<string[]>("get_blacklist"),
      invoke<boolean>("get_smtc_whitelist_enabled"),
      invoke<string[]>("get_smtc_whitelist"),
      invoke<string>("get_log_level"),
    ]);
    autoStart.checked = startsWithWindows;
    indicatorColor.value = core.indicator_color || "#2edb67";
    lyricMode.value = core.lyric_mode || "off";
    lyricOffsetEnabled.checked = core.lyric_offset_enabled ?? true;
    blacklistEnabled.checked = blacklistOn;
    blacklist.value = blocked.join("\n");
    smtcWhitelistEnabled.checked = smtcOn;
    smtcWhitelist.value = players.join("\n");
    logLevel.value = level || "info";
    obsidianVaultPath.value = core.obsidian_vault_path || "";
    obsidianDailyNotesDir.value = core.obsidian_daily_notes_dir || "Daily";
    await refreshCodexStatus();
  } catch (error) {
    console.error(error);
    showStatus("设置加载失败", true);
  }
}

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  try {
    await Promise.all([
      invoke("set_core_preferences", {
        indicatorColor: indicatorColor.value,
        lyricMode: lyricMode.value,
        lyricOffsetEnabled: lyricOffsetEnabled.checked,
      }),
      invoke("set_auto_start", { enabled: autoStart.checked }),
      invoke("set_blacklist_enabled", { enabled: blacklistEnabled.checked }),
      invoke("save_blacklist", { processes: lines(blacklist.value) }),
      invoke("set_smtc_whitelist_enabled", { enabled: smtcWhitelistEnabled.checked }),
      invoke("save_smtc_whitelist", { appIds: lines(smtcWhitelist.value) }),
      invoke("set_log_level", { level: logLevel.value }),
      invoke("set_obsidian_preferences", {
        vaultPath: obsidianVaultPath.value,
        dailyNotesDir: obsidianDailyNotesDir.value,
      }),
    ]);
    showStatus("已保存");
  } catch (error) {
    console.error(error);
    showStatus("保存失败", true);
  } finally {
    saveButton.disabled = false;
  }
});

element<HTMLButtonElement>("open-log-dir").addEventListener("click", () => {
  void invoke("open_log_dir");
});

installCodexHooks.addEventListener("click", async () => {
  installCodexHooks.disabled = true;
  try {
    await invoke("install_codex_status_hooks");
    await refreshCodexStatus();
    showStatus("Hooks 已安装，请重启 Codex");
  } catch (error) {
    console.error(error);
    showStatus(String(error), true);
  } finally {
    installCodexHooks.disabled = false;
  }
});

clearCodexStatus.addEventListener("click", async () => {
  try {
    renderCodexStatus(await invoke<CodexStatus>("clear_codex_status"));
    showStatus("Codex 状态已清除");
  } catch (error) {
    console.error(error);
    showStatus(String(error), true);
  }
});

void loadSettings();
