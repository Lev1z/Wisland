import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLyricOffset } from "./settings-lyric-offset";

type CustomAsset = { id: string; name: string; data_url: string };

type CoreSettings = {
  indicator_color?: string;
  capsule_opacity?: number;
  capsule_scale?: number;
  icon_bar_style?: string;
  icon_bar_order?: string[];
  border_effect?: string;
  border_custom_source?: string;
  left_visual_mode?: string;
  left_visual_source?: string;
  right_visual_mode?: string;
  right_visual_source?: string;
  visual_assets?: CustomAsset[];
  border_assets?: CustomAsset[];
  obsidian_vault_path?: string;
  obsidian_daily_notes_dir?: string;
};

type CodexStatus = { phase: "idle" | "running" | "completed" | "failed" | "stale" };
type CodexCliStatus = { ready: boolean; desktopInstalled: boolean; connectable: boolean; source?: string; message: string };
type CodexQuota = { available: boolean; remainingPercent?: number; message?: string; source?: string };
type SmtcSession = {
  appId: string;
  title: string;
  artist: string;
  playbackStatus: string;
  playing: boolean;
  preferred: boolean;
  whitelisted: boolean;
  eligible: boolean;
  readable: boolean;
};
type ViewId = "time" | "lyric" | "journal" | "tray";
type VisualSide = "left" | "right";

const builtinVisuals = [
  { id: "cat-wave", name: "猫猫挥手", source: "/assets/visuals/cat-wave.gif" },
  { id: "dog-wave", name: "小狗奔跑", source: "/assets/visuals/dog-wave.gif" },
] as const;

const viewLabels: Record<ViewId, string> = {
  time: "主页",
  lyric: "音乐",
  journal: "日记",
  tray: "临时托盘",
};

const pageMeta: Record<string, { title: string; description: string }> = {
  general: { title: "常规", description: "基础外观、启动方式与导航顺序。" },
  music: { title: "音乐", description: "始终保留歌曲信息与歌词，并按播放器校准时间。" },
  codex: { title: "Codex", description: "连接任务状态 Hooks。" },
  obsidian: { title: "Obsidian", description: "设置随手记写入位置。" },
  custom: { title: "自定义", description: "左右动图与动态边框方案。" },
  behavior: { title: "行为", description: "自动隐藏、进程规则与诊断。" },
  about: { title: "关于", description: "版本与项目边界。" },
};

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

const shell = element<HTMLElement>("settings-shell");
const title = element<HTMLElement>("page-title");
const description = element<HTMLElement>("page-description");
const status = element<HTMLElement>("save-status");
const contentBody = document.querySelector<HTMLElement>(".content-body")!;
const autoStart = element<HTMLInputElement>("auto-start");
const indicatorColor = element<HTMLInputElement>("indicator-color");
const capsuleOpacity = element<HTMLInputElement>("capsule-opacity");
const capsuleOpacityValue = element<HTMLOutputElement>("capsule-opacity-value");
const capsuleScale = element<HTMLSelectElement>("capsule-scale");
const iconBarStyle = element<HTMLSelectElement>("icon-bar-style");
const iconOrderList = element<HTMLElement>("icon-order-list");
const smtcWhitelistEnabled = element<HTMLInputElement>("smtc-whitelist-enabled");
const smtcWhitelist = element<HTMLTextAreaElement>("smtc-whitelist");
const blacklistEnabled = element<HTMLInputElement>("blacklist-enabled");
const blacklist = element<HTMLTextAreaElement>("blacklist");
const logLevel = element<HTMLSelectElement>("log-level");
const obsidianVaultPath = element<HTMLInputElement>("obsidian-vault-path");
const obsidianDailyNotesDir = element<HTMLInputElement>("obsidian-daily-notes-dir");
const codexHookState = element<HTMLElement>("codex-hook-state");
const installCodexHooks = element<HTMLButtonElement>("install-codex-hooks");
const clearCodexStatus = element<HTMLButtonElement>("clear-codex-status");
const scanSmtc = element<HTMLButtonElement>("scan-smtc");
const smtcScanResult = element<HTMLElement>("smtc-scan-result");
const codexQuotaState = element<HTMLElement>("codex-quota-state");
const codexQuotaDetail = element<HTMLElement>("codex-quota-detail");
const checkCodexQuota = element<HTMLButtonElement>("check-codex-quota");
const openOnboarding = element<HTMLButtonElement>("open-onboarding");
const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));

let iconOrder: ViewId[] = ["time", "lyric", "journal", "tray"];
let borderEffect = "off";
let borderCustomSource = "";
let leftVisualMode = "codex";
let leftVisualSource = "";
let rightVisualMode = "status";
let rightVisualSource = "";
let visualAssets: CustomAsset[] = [];
let borderAssets: CustomAsset[] = [];
let draggedView: ViewId | null = null;
let dragOverView: ViewId | null = null;
let hydrating = true;
let saveTimer = 0;
let statusTimer = 0;
let persistChain: Promise<void> = Promise.resolve();

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function showStatus(message: string, error = false, clearAfter = 1800): void {
  window.clearTimeout(statusTimer);
  status.textContent = message;
  status.style.color = error ? "#ff7b88" : "#8fa8ff";
  if (clearAfter > 0) {
    statusTimer = window.setTimeout(() => {
      if (status.textContent === message) status.textContent = "";
    }, clearAfter);
  }
}

function updateRangeLabel(): void {
  const value = Number(capsuleOpacity.value);
  capsuleOpacityValue.value = `${value}%`;
  capsuleOpacity.style.setProperty("--range-progress", `${(value - 60) / 40 * 100}%`);
}

function nearestScale(value: number): number {
  return [0.8, 1, 1.25, 1.5].reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, 1);
}

function normalizeOrder(value: string[] | undefined): ViewId[] {
  const defaults: ViewId[] = ["time", "lyric", "journal", "tray"];
  const output: ViewId[] = [];
  for (const item of [...(value ?? []), ...defaults]) {
    if (defaults.includes(item as ViewId) && !output.includes(item as ViewId)) output.push(item as ViewId);
  }
  return output;
}

function renderIconOrder(): void {
  iconOrderList.replaceChildren();
  iconOrder.forEach((view, index) => {
    const row = document.createElement("div");
    row.className = "order-row";
    row.dataset.view = view;
    const label = document.createElement("span");
    label.className = "order-label";
    const handle = document.createElement("i");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    const number = document.createElement("b");
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.textContent = viewLabels[view];
    label.append(handle, number, name);
    const hint = document.createElement("span");
    hint.className = "drag-copy";
    hint.textContent = "拖拽排序";
    row.append(label, hint);
    row.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      draggedView = view;
      dragOverView = view;
      row.classList.add("dragging");
    });
    iconOrderList.appendChild(row);
  });
}

window.addEventListener("mousemove", (event) => {
  if (!draggedView || (event.buttons & 1) === 0) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>(".order-row");
  const target = row?.dataset.view as ViewId | undefined;
  if (!target || target === dragOverView) return;
  dragOverView = target;
  document.querySelectorAll(".order-row").forEach((item) => {
    item.classList.toggle("drag-over", (item as HTMLElement).dataset.view === target && target !== draggedView);
  });
});
window.addEventListener("mouseup", (event) => {
  const movedView = draggedView;
  const targetRow = (event.target as HTMLElement).closest<HTMLElement>(".order-row");
  const targetView = (targetRow?.dataset.view as ViewId | undefined) ?? dragOverView;
  draggedView = null;
  dragOverView = null;
  document.querySelectorAll(".order-row").forEach((item) => item.classList.remove("dragging", "drag-over"));
  if (!movedView || !targetView || movedView === targetView) return;
  const from = iconOrder.indexOf(movedView);
  const to = iconOrder.indexOf(targetView);
  if (from < 0 || to < 0) return;
  const [moved] = iconOrder.splice(from, 1);
  iconOrder.splice(to, 0, moved);
  renderIconOrder();
  queueSave(80);
});

function visualState(side: VisualSide): { mode: string; source: string } {
  return side === "left"
    ? { mode: leftVisualMode, source: leftVisualSource }
    : { mode: rightVisualMode, source: rightVisualSource };
}

function setVisualState(side: VisualSide, mode: string, source: string): void {
  if (side === "left") {
    leftVisualMode = mode;
    leftVisualSource = source;
  } else {
    rightVisualMode = mode;
    rightVisualSource = source;
  }
}

function renderVisualOptions(side: VisualSide): void {
  const container = element<HTMLElement>(`${side}-visual-options`);
  const state = visualState(side);
  container.replaceChildren();
  const native = document.createElement("button");
  native.type = "button";
  native.className = "visual-option";
  native.classList.toggle("active", state.mode !== "custom");
  const nativePreview = document.createElement("i");
  nativePreview.className = "visual-native-preview";
  nativePreview.textContent = side === "left" ? "%" : "●";
  native.append(nativePreview, visualCopy(side === "left" ? "Codex Quota" : "Status Light", "Wisland default"));
  native.addEventListener("click", () => {
    setVisualState(side, side === "left" ? "codex" : "status", state.source);
    renderVisualOptions(side);
    queueSave(80);
  });
  container.appendChild(native);

  for (const builtin of builtinVisuals) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "visual-option";
    button.classList.toggle("active", state.mode === "custom" && state.source === `builtin:${builtin.id}`);
    const preview = document.createElement("img");
    preview.alt = "";
    preview.src = builtin.source;
    button.append(preview, visualCopy(builtin.name, "Wisland built-in"));
    button.addEventListener("click", () => {
      setVisualState(side, "custom", `builtin:${builtin.id}`);
      renderVisualOptions(side);
      queueSave(80);
    });
    container.appendChild(button);
  }

  for (const asset of visualAssets) {
    const choice = document.createElement("div");
    choice.className = "asset-choice";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "visual-option";
    button.classList.toggle("active", state.mode === "custom" && state.source === `asset:${asset.id}`);
    const preview = document.createElement("img");
    preview.alt = "";
    preview.src = asset.data_url;
    button.append(preview, visualCopy(asset.name || "未命名素材", "Imported animation"));
    button.addEventListener("click", () => {
      setVisualState(side, "custom", `asset:${asset.id}`);
      renderVisualOptions(side);
      queueSave(80);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "asset-delete";
    remove.title = `删除 ${asset.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteVisualAsset(asset.id));
    choice.append(button, remove);
    container.appendChild(choice);
  }
  updateAssetCounters();
}

function visualCopy(name: string, detail: string): HTMLSpanElement {
  const copy = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = name;
  const small = document.createElement("small");
  small.textContent = detail;
  copy.append(strong, small);
  return copy;
}

function deleteVisualAsset(id: string): void {
  visualAssets = visualAssets.filter((asset) => asset.id !== id);
  if (leftVisualSource === `asset:${id}`) {
    leftVisualMode = "codex";
    leftVisualSource = "";
  }
  if (rightVisualSource === `asset:${id}`) {
    rightVisualMode = "status";
    rightVisualSource = "";
  }
  renderVisualOptions("left");
  renderVisualOptions("right");
  queueSave(0);
}

function renderBorderEffects(): void {
  document.querySelectorAll<HTMLButtonElement>("#border-effect-options button").forEach((button) => {
    button.classList.toggle("active", button.dataset.effect === borderEffect);
  });
  const container = element<HTMLElement>("border-asset-options");
  container.replaceChildren();
  for (const asset of borderAssets) {
    const choice = document.createElement("div");
    choice.className = "asset-choice";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "visual-option border-asset-option";
    button.classList.toggle("active", borderEffect === "custom" && borderCustomSource === `asset:${asset.id}`);
    const preview = document.createElement("img");
    preview.alt = "";
    preview.src = asset.data_url;
    button.append(preview, visualCopy(asset.name || "未命名边框", "Custom border"));
    button.addEventListener("click", () => {
      borderEffect = "custom";
      borderCustomSource = `asset:${asset.id}`;
      renderBorderEffects();
      queueSave(80);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "asset-delete";
    remove.title = `删除 ${asset.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      borderAssets = borderAssets.filter((item) => item.id !== asset.id);
      if (borderCustomSource === `asset:${asset.id}`) {
        borderEffect = "off";
        borderCustomSource = "";
      }
      renderBorderEffects();
      queueSave(0);
    });
    choice.append(button, remove);
    container.appendChild(choice);
  }
  updateAssetCounters();
}

function updateAssetCounters(): void {
  const visualText = visualAssets.length ? `素材库：${visualAssets.length} 个` : "可连续导入多个素材";
  element<HTMLElement>("left-import-name").textContent = visualText;
  element<HTMLElement>("right-import-name").textContent = visualText;
  element<HTMLElement>("border-import-name").textContent = borderAssets.length
    ? `边框素材：${borderAssets.length} 个`
    : "可保存并切换多个边框素材";
}

async function readImageFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片或动图文件");
  if (file.size > 4 * 1024 * 1024) throw new Error("素材不能超过 4 MB");
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
}

function wireImageImport(side: VisualSide): void {
  const fileInput = element<HTMLInputElement>(`${side}-visual-file`);
  const importButton = element<HTMLButtonElement>(`import-${side}-visual`);
  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files ?? []);
    if (!files.length) return;
    try {
      let lastAsset: CustomAsset | null = null;
      for (const file of files) {
        lastAsset = {
          id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name,
          data_url: await readImageFile(file),
        };
        visualAssets.push(lastAsset);
      }
      if (lastAsset) setVisualState(side, "custom", `asset:${lastAsset.id}`);
      renderVisualOptions("left");
      renderVisualOptions("right");
      queueSave(0);
    } catch (error) {
      showStatus(String(error), true, 3500);
    } finally {
      fileInput.value = "";
    }
  });
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
  codexHookState.style.color = value.phase === "failed" ? "#ff7b88" : value.phase === "running" ? "#f4b451" : "#9bb0ff";
}

async function refreshCodexStatus(): Promise<void> {
  renderCodexStatus(await invoke<CodexStatus>("get_codex_status"));
}

function renderCodexConnection(value: CodexCliStatus): void {
  codexQuotaState.classList.remove("success", "warning");
  if (value.ready) {
    codexQuotaState.textContent = "可验证";
    codexQuotaState.classList.add("warning");
  } else if (value.connectable) {
    codexQuotaState.textContent = "可连接";
    codexQuotaState.classList.add("warning");
  } else {
    codexQuotaState.textContent = "未找到";
  }
  codexQuotaDetail.textContent = value.message + (value.source ? ` · ${value.source}` : "");
}

async function refreshCodexConnection(): Promise<void> {
  renderCodexConnection(await invoke<CodexCliStatus>("get_codex_cli_status"));
}

function renderSmtcDiagnostics(sessions: SmtcSession[]): void {
  smtcScanResult.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("span");
    empty.textContent = "未发现 SMTC 会话。请让播放器开始播放后重试；这通常表示播放器未向 Windows 发布媒体状态。";
    smtcScanResult.append(empty);
    return;
  }
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = `diagnostic-session${session.eligible ? " accepted" : ""}`;
    const name = document.createElement("strong");
    name.textContent = session.appId || "未知应用标识";
    const metadata = document.createElement("small");
    const track = [session.title, session.artist].filter(Boolean).join(" · ") || "未读取到歌曲信息";
    metadata.textContent = `${track} · ${session.playbackStatus} · ${session.eligible ? "已允许" : "未允许"}`;
    row.append(name, metadata);
    if (!session.eligible && session.appId) {
      const allow = document.createElement("button");
      allow.type = "button";
      allow.className = "btn btn-small";
      allow.textContent = "加入白名单";
      allow.addEventListener("click", async () => {
        allow.disabled = true;
        try {
          const normalized = session.appId.toLowerCase();
          const values = lines(smtcWhitelist.value);
          if (!values.some((value) => normalized.includes(value.toLowerCase()))) values.push(session.appId);
          smtcWhitelist.value = values.join("\n");
          smtcWhitelistEnabled.checked = true;
          await invoke("save_smtc_whitelist", { appIds: values });
          await invoke("set_smtc_whitelist_enabled", { enabled: true });
          await runSmtcScan();
        } catch (error) {
          showStatus(String(error), true, 4000);
        } finally {
          allow.disabled = false;
        }
      });
      row.append(allow);
    }
    smtcScanResult.append(row);
  }
}

async function runSmtcScan(): Promise<void> {
  scanSmtc.disabled = true;
  smtcScanResult.textContent = "正在读取 Windows SMTC 会话…";
  try {
    renderSmtcDiagnostics(await invoke<SmtcSession[]>("diagnose_smtc_sessions"));
  } catch (error) {
    smtcScanResult.textContent = `扫描失败：${String(error)}`;
  } finally {
    scanSmtc.disabled = false;
  }
}

function playMenuIntro(): void {
  shell.classList.remove("menu-open");
  shell.classList.add("menu-resetting");
  void shell.offsetWidth;
  shell.classList.remove("menu-resetting");
  requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.add("menu-open")));
}

function activatePage(page: string, button: HTMLButtonElement): void {
  const current = document.querySelector<HTMLElement>(".page.active");
  const next = element<HTMLElement>(`page-${page}`);
  if (current === next) return;
  navItems.forEach((item) => item.classList.toggle("active", item === button));
  if (current) {
    current.classList.remove("active");
    current.classList.add("page-leaving");
    window.setTimeout(() => current.classList.remove("page-leaving"), 180);
  }
  next.classList.add("active");
  title.textContent = pageMeta[page].title;
  description.textContent = pageMeta[page].description;
  contentBody.scrollTo({ top: 0, behavior: "smooth" });
}

async function persistSettings(): Promise<void> {
  showStatus("正在应用…", false, 0);
  try {
    await invoke("set_core_preferences", {
      indicatorColor: indicatorColor.value,
      lyricMode: "lyric",
      lyricOffsetEnabled: true,
    });
    await invoke("set_appearance_preferences", {
      opacity: Number(capsuleOpacity.value) / 100,
      scale: Number(capsuleScale.value),
      iconBarStyle: iconBarStyle.value,
      iconBarOrder: iconOrder,
      borderEffect,
      borderCustomSource,
      leftVisualMode,
      leftVisualSource,
      rightVisualMode,
      rightVisualSource,
      visualAssets,
      borderAssets,
    });
    await invoke("set_auto_start", { enabled: autoStart.checked });
    await invoke("set_blacklist_enabled", { enabled: blacklistEnabled.checked });
    await invoke("save_blacklist", { processes: lines(blacklist.value) });
    await invoke("set_smtc_whitelist_enabled", { enabled: smtcWhitelistEnabled.checked });
    await invoke("save_smtc_whitelist", { appIds: lines(smtcWhitelist.value) });
    await invoke("set_log_level", { level: logLevel.value });
    await invoke("set_obsidian_preferences", {
      vaultPath: obsidianVaultPath.value,
      dailyNotesDir: obsidianDailyNotesDir.value,
    });
    showStatus("已应用");
  } catch (error) {
    console.error(error);
    showStatus(`应用失败：${String(error)}`, true, 4000);
  }
}

function queueSave(delay = 280): void {
  if (hydrating) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    persistChain = persistChain.then(persistSettings, persistSettings);
  }, delay);
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
    indicatorColor.value = core.indicator_color || "#ffffff";
    capsuleOpacity.value = String(Math.round((core.capsule_opacity ?? 1) * 100));
    capsuleScale.value = String(nearestScale(core.capsule_scale ?? 1));
    iconBarStyle.value = core.icon_bar_style === "classic" ? "classic" : "option-wheel";
    iconOrder = normalizeOrder(core.icon_bar_order);
    borderEffect = core.border_effect ?? "off";
    borderCustomSource = core.border_custom_source ?? "";
    leftVisualMode = core.left_visual_mode ?? "codex";
    leftVisualSource = core.left_visual_source ?? "";
    rightVisualMode = core.right_visual_mode ?? "status";
    rightVisualSource = core.right_visual_source ?? "";
    visualAssets = core.visual_assets ?? [];
    borderAssets = core.border_assets ?? [];
    blacklistEnabled.checked = blacklistOn;
    blacklist.value = blocked.join("\n");
    smtcWhitelistEnabled.checked = smtcOn;
    smtcWhitelist.value = players.join("\n");
    logLevel.value = level || "info";
    obsidianVaultPath.value = core.obsidian_vault_path || "";
    obsidianDailyNotesDir.value = core.obsidian_daily_notes_dir || "Daily";
    updateRangeLabel();
    renderIconOrder();
    renderVisualOptions("left");
    renderVisualOptions("right");
    renderBorderEffects();
    await Promise.all([refreshCodexStatus(), refreshCodexConnection()]);
  } catch (error) {
    console.error(error);
    showStatus("设置加载失败", true, 4000);
  } finally {
    hydrating = false;
  }
}

navItems.forEach((button, index) => {
  button.style.setProperty("--menu-index", String(index));
  button.addEventListener("click", () => activatePage(button.dataset.page ?? "general", button));
});

document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(".autosave").forEach((control) => {
  const eventName = control instanceof HTMLTextAreaElement || control.type === "range" ? "input" : "change";
  control.addEventListener(eventName, () => {
    if (control === capsuleOpacity) updateRangeLabel();
    queueSave(control instanceof HTMLTextAreaElement ? 520 : 220);
  });
});

document.querySelectorAll<HTMLButtonElement>("#border-effect-options button").forEach((button) => {
  button.addEventListener("click", () => {
    borderEffect = button.dataset.effect ?? "off";
    renderBorderEffects();
    queueSave(80);
  });
});

wireImageImport("left");
wireImageImport("right");
const borderFile = element<HTMLInputElement>("border-visual-file");
element<HTMLButtonElement>("import-border-visual").addEventListener("click", () => borderFile.click());
borderFile.addEventListener("change", async () => {
  const files = Array.from(borderFile.files ?? []);
  if (!files.length) return;
  try {
    let lastAsset: CustomAsset | null = null;
    for (const file of files) {
      lastAsset = {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        data_url: await readImageFile(file),
      };
      borderAssets.push(lastAsset);
    }
    if (lastAsset) {
      borderCustomSource = `asset:${lastAsset.id}`;
      borderEffect = "custom";
    }
    renderBorderEffects();
    queueSave(0);
  } catch (error) {
    showStatus(String(error), true, 3500);
  } finally {
    borderFile.value = "";
  }
});

element<HTMLButtonElement>("open-log-dir").addEventListener("click", () => void invoke("open_log_dir"));
element<HTMLButtonElement>("open-github-profile").addEventListener("click", async () => {
  try {
    await invoke("open_github_profile");
  } catch (error) {
    showStatus(String(error), true, 4000);
  }
});
installCodexHooks.addEventListener("click", async () => {
  installCodexHooks.disabled = true;
  try {
    await invoke("install_codex_status_hooks");
    await refreshCodexStatus();
    showStatus("Hooks 已安装，请重启 Codex", false, 3500);
  } catch (error) {
    showStatus(String(error), true, 4000);
  } finally {
    installCodexHooks.disabled = false;
  }
});
clearCodexStatus.addEventListener("click", async () => {
  try {
    renderCodexStatus(await invoke<CodexStatus>("clear_codex_status"));
    showStatus("Codex 状态已清除");
  } catch (error) {
    showStatus(String(error), true, 4000);
  }
});
scanSmtc.addEventListener("click", () => void runSmtcScan());
checkCodexQuota.addEventListener("click", async () => {
  checkCodexQuota.disabled = true;
  codexQuotaState.textContent = "连接中";
  codexQuotaState.classList.add("warning");
  codexQuotaDetail.textContent = "首次连接可能需要复用 Codex Desktop 的本地运行组件…";
  try {
    const value = await invoke<CodexQuota>("connect_codex_quota");
    codexQuotaState.classList.remove("success", "warning");
    if (value.available) {
      codexQuotaState.textContent = "已连接";
      codexQuotaState.classList.add("success");
      codexQuotaDetail.textContent = `${value.source || "Codex CLI"}${value.remainingPercent != null ? ` · 剩余 ${Math.round(value.remainingPercent)}%` : ""}`;
    } else {
      codexQuotaState.textContent = "连接失败";
      codexQuotaDetail.textContent = value.message || "Codex 未返回额度信息";
    }
  } catch (error) {
    codexQuotaState.textContent = "连接失败";
    codexQuotaDetail.textContent = String(error);
  } finally {
    checkCodexQuota.disabled = false;
  }
});
openOnboarding.addEventListener("click", async () => {
  try {
    await invoke("open_onboarding_window");
  } catch (error) {
    showStatus(String(error), true, 4000);
  }
});

const settingsWindow = getCurrentWindow();
const titlebar = element<HTMLElement>("window-titlebar");
let windowPosition = { x: 0, y: 0 };
let titlebarDrag: { screenX: number; screenY: number; windowX: number; windowY: number } | null = null;
let pendingWindowPosition: { x: number; y: number } | null = null;
let windowMoveFrame = 0;
let resizePositionTimer = 0;

function syncWindowPosition(): void {
  void settingsWindow.outerPosition().then(({ x, y }) => {
    windowPosition = { x, y };
  });
}

syncWindowPosition();
void settingsWindow.onMoved(({ payload }) => {
  windowPosition = { x: payload.x, y: payload.y };
});
window.addEventListener("resize", () => {
  window.clearTimeout(resizePositionTimer);
  resizePositionTimer = window.setTimeout(syncWindowPosition, 80);
});
titlebar.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || (event.target as HTMLElement).closest(".window-controls")) return;
  event.preventDefault();
  titlebarDrag = {
    screenX: event.screenX,
    screenY: event.screenY,
    windowX: windowPosition.x,
    windowY: windowPosition.y,
  };
});
window.addEventListener("mousemove", (event) => {
  if (!titlebarDrag || (event.buttons & 1) === 0) return;
  const scale = window.devicePixelRatio || 1;
  const next = {
    x: titlebarDrag.windowX + Math.round((event.screenX - titlebarDrag.screenX) * scale),
    y: titlebarDrag.windowY + Math.round((event.screenY - titlebarDrag.screenY) * scale),
  };
  pendingWindowPosition = next;
  if (windowMoveFrame) return;
  windowMoveFrame = requestAnimationFrame(() => {
    windowMoveFrame = 0;
    const target = pendingWindowPosition;
    pendingWindowPosition = null;
    if (!target) return;
    windowPosition = target;
    void settingsWindow.setPosition(new PhysicalPosition(target.x, target.y));
  });
});
window.addEventListener("mouseup", () => {
  titlebarDrag = null;
  window.setTimeout(syncWindowPosition, 40);
});
element<HTMLButtonElement>("window-minimize").addEventListener("click", () => void settingsWindow.minimize());
element<HTMLButtonElement>("window-maximize").addEventListener("click", () => void settingsWindow.toggleMaximize());
element<HTMLButtonElement>("window-close").addEventListener("click", () => void settingsWindow.close());

void listen("settings-menu-open", playMenuIntro);
playMenuIntro();
initLyricOffset();
void loadSettings();
