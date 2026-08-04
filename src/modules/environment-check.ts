import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  capsule,
  environmentCheckArea,
  environmentCheckFull,
  environmentCheckList,
  environmentCompactIcon,
  environmentCompactText,
  environmentRefresh,
  environmentSkip,
} from "../dom";
import { setSkipResizeSync } from "../state";

type CheckState = "checking" | "ready" | "warning";
type CheckId = "runtime" | "webview" | "desktop" | "hooks" | "quota" | "player" | "obsidian";
type CheckAction = { label: string; run: () => Promise<void> };
type CheckItem = {
  id: CheckId;
  label: string;
  detail: string;
  state: CheckState;
  action?: CheckAction;
  guide?: { steps: string[]; actions: CheckAction[] };
};
type PlatformStatus = {
  webview2Version: string;
  codexDesktopInstalled: boolean;
  codexDesktopRunning: boolean;
  codexHooksInstalled: boolean;
};
type CodexCliStatus = {
  available: boolean;
  path: string | null;
  source: string | null;
  npmAvailable: boolean;
  npmPath: string | null;
  authenticated: boolean | null;
  message: string;
};
type CodexQuota = { available: boolean; remainingPercent: number | null; message: string | null };
type SmtcSession = {
  appId: string;
  appName: string;
  title: string;
  artist: string;
  playbackStatus: string;
  preferred: boolean;
};
type SmtcProbe = { sessions: SmtcSession[]; hint: string };
type CoreSettings = { obsidian_vault_path?: string };

const order: CheckId[] = ["runtime", "webview", "desktop", "hooks", "quota", "player", "obsidian"];
let items = new Map<CheckId, CheckItem>();
let active = false;
let compactIndex = 0;
let compactTimer = 0;
let checkGeneration = 0;
let heightFrame = 0;
let heightResizeTimer = 0;
let lastMeasuredHeight = 0;

const ENVIRONMENT_HEIGHT_MIN = 360;
const ENVIRONMENT_HEIGHT_MAX = 640;
const CAPSULE_TRANSITION_MS = 390;

function measureEnvironmentHeight(): void {
  if (!active || environmentCheckArea.hidden) return;
  const naturalHeight = Math.ceil(environmentCheckFull.scrollHeight);
  if (naturalHeight <= 0) return;
  const height = Math.max(ENVIRONMENT_HEIGHT_MIN, Math.min(ENVIRONMENT_HEIGHT_MAX, naturalHeight));
  if (height === lastMeasuredHeight) return;
  lastMeasuredHeight = height;

  const expanded = capsule.classList.contains("expanded");
  if (expanded) setSkipResizeSync(true);
  document.documentElement.style.setProperty("--environment-check-expanded-h", `${height}px`);
  void invoke("sync_environment_check_height", { height, resize: false });

  window.clearTimeout(heightResizeTimer);
  if (expanded) {
    heightResizeTimer = window.setTimeout(() => {
      void invoke("sync_environment_check_height", { height, resize: true })
        .finally(() => setSkipResizeSync(false));
    }, CAPSULE_TRANSITION_MS);
  }
}

function scheduleEnvironmentHeight(): void {
  window.cancelAnimationFrame(heightFrame);
  heightFrame = window.requestAnimationFrame(() => {
    heightFrame = 0;
    measureEnvironmentHeight();
  });
}

function checkingItems(): Map<CheckId, CheckItem> {
  return new Map<CheckId, CheckItem>([
    ["runtime", { id: "runtime", label: "Wisland 运行环境", detail: "正在检查", state: "checking" }],
    ["webview", { id: "webview", label: "WebView2", detail: "正在检查", state: "checking" }],
    ["desktop", { id: "desktop", label: "Codex Desktop", detail: "正在检查", state: "checking" }],
    ["hooks", { id: "hooks", label: "Codex Hooks", detail: "正在检查", state: "checking" }],
    ["quota", { id: "quota", label: "Codex 额度服务", detail: "正在检查", state: "checking" }],
    ["player", { id: "player", label: "系统媒体控制", detail: "正在扫描 SMTC", state: "checking" }],
    ["obsidian", { id: "obsidian", label: "Obsidian", detail: "正在检查", state: "checking" }],
  ]);
}

function iconText(state: CheckState): string {
  return state === "ready" ? "✓" : state === "warning" ? "!" : "";
}

function renderCompact(animate = false): void {
  const visible = order.map((id) => items.get(id)).filter((item): item is CheckItem => !!item);
  const item = visible[compactIndex % Math.max(1, visible.length)];
  if (!item) return;
  environmentCompactIcon.className = `environment-status-icon ${item.state}`;
  environmentCompactIcon.textContent = iconText(item.state);
  environmentCompactText.textContent = `${item.label} · ${item.detail}`;
  if (animate) {
    const compact = environmentCompactText.parentElement;
    compact?.classList.remove("rolling");
    void compact?.getBoundingClientRect();
    compact?.classList.add("rolling");
  }
}

function render(): void {
  environmentCheckList.replaceChildren();
  for (const id of order) {
    const item = items.get(id);
    if (!item) continue;
    const row = document.createElement("div");
    row.className = `environment-row ${item.state}`;
    const icon = document.createElement("span");
    icon.className = `environment-status-icon ${item.state}`;
    icon.textContent = iconText(item.state);
    icon.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "environment-row-copy";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    detail.title = item.detail;
    copy.append(label, detail);
    row.append(icon, copy);
    if (item.action) {
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = item.action.label;
      action.addEventListener("click", async (event) => {
        event.stopPropagation();
        action.disabled = true;
        try {
          await item.action?.run();
        } finally {
          action.disabled = false;
        }
      });
      row.append(action);
    }
    if (item.guide) {
      row.classList.add("with-guide");
      const guide = document.createElement("div");
      guide.className = "environment-inline-guide";
      const steps = document.createElement("ol");
      for (const step of item.guide.steps) {
        const entry = document.createElement("li");
        entry.textContent = step;
        steps.append(entry);
      }
      const actions = document.createElement("div");
      actions.className = "environment-guide-actions";
      for (const guideAction of item.guide.actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = guideAction.label;
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          button.disabled = true;
          try {
            await guideAction.run();
          } finally {
            button.disabled = false;
          }
        });
        actions.append(button);
      }
      guide.append(steps, actions);
      row.append(guide);
    }
    environmentCheckList.appendChild(row);
  }
  renderCompact();
  scheduleEnvironmentHeight();
}

function update(item: CheckItem): void {
  items.set(item.id, item);
  render();
}

async function scanPlayer(): Promise<void> {
  update({ id: "player", label: "系统媒体控制", detail: "正在扫描 SMTC", state: "checking" });
  try {
    const result = await invoke<SmtcProbe>("probe_smtc_sessions");
    const preferred = result.sessions.find((session) => session.preferred);
    if (preferred) {
      const track = preferred.title ? ` · ${preferred.title}` : "";
      update({
        id: "player",
        label: `已发现播放器：${preferred.appName}`,
        detail: `${preferred.playbackStatus}${track}`,
        state: "ready",
        action: { label: "重扫", run: scanPlayer },
      });
    } else {
      const detail = result.sessions.length
        ? `发现 ${result.sessions.length} 个会话，但没有可识别音乐播放器`
        : result.hint;
      update({
        id: "player",
        label: "未发现可识别播放器",
        detail,
        state: "warning",
        action: { label: "重扫", run: scanPlayer },
      });
    }
  } catch (error) {
    update({ id: "player", label: "SMTC 扫描失败", detail: String(error), state: "warning", action: { label: "重试", run: scanPlayer } });
  }
}

async function connectQuota(cli: CodexCliStatus): Promise<void> {
  update({ id: "quota", label: "Codex 额度服务", detail: "正在连接 App Server", state: "checking" });
  const quota = await invoke<CodexQuota>("check_codex_quota");
  if (quota.available && quota.remainingPercent !== null) {
    update({ id: "quota", label: "Codex 额度服务", detail: `已连接 · 剩余 ${Math.round(quota.remainingPercent)}%`, state: "ready", action: { label: "刷新", run: () => connectQuota(cli) } });
  } else {
    update({ id: "quota", label: "Codex 额度服务尚未连接", detail: quota.message ?? "连接失败", state: "warning", action: { label: "重试", run: () => connectQuota(cli) } });
  }
}

async function startCodexLogin(): Promise<void> {
  update({
    id: "quota",
    label: "正在启动 Codex 登录",
    detail: "正在检查 CLI 与 Node.js 运行环境",
    state: "checking",
  });
  try {
    await invoke("start_codex_login");
    update({
      id: "quota",
      label: "等待 Codex 登录",
      detail: "请在新窗口和浏览器中完成登录，然后重新检测",
      state: "warning",
      action: { label: "重新检测", run: refreshCodexCli },
    });
  } catch (error) {
    update({
      id: "quota",
      label: "无法启动 Codex 登录",
      detail: String(error),
      state: "warning",
      action: { label: "重试", run: startCodexLogin },
    });
  }
}

function applyCodexCliStatus(cli: CodexCliStatus): void {
  if (cli.available) {
    if (cli.authenticated === false) {
      update({
        id: "quota",
        label: "Codex CLI 尚未登录",
        detail: cli.source ? `已安装 · ${cli.source}` : "已安装，请先登录",
        state: "warning",
        action: { label: "登录", run: startCodexLogin },
      });
      return;
    }
    void connectQuota(cli);
    return;
  }

  if (cli.npmAvailable) {
    update({
      id: "quota",
      label: "Codex CLI 尚未安装",
      detail: "已检测到 npm，可以直接安装",
      state: "warning",
      action: { label: "一键安装", run: installCodexCli },
    });
    return;
  }

  update({
    id: "quota",
    label: "缺少 Codex CLI 与 npm",
    detail: "先安装 Node.js LTS，无需查阅额外教程",
    state: "warning",
    action: { label: "重新检测", run: refreshCodexCli },
    guide: {
      steps: [
        "安装 Node.js LTS（安装包会同时提供 npm）",
        "返回 Wisland，点击“重新检测”",
        "点击“一键安装”，再按提示登录 Codex",
      ],
      actions: [
        { label: "下载 Node.js", run: async () => { await invoke("open_nodejs_download"); } },
      ],
    },
  });
}

async function refreshCodexCli(): Promise<void> {
  update({ id: "quota", label: "Codex CLI", detail: "正在重新检测", state: "checking" });
  try {
    applyCodexCliStatus(await invoke<CodexCliStatus>("get_codex_cli_status"));
  } catch (error) {
    update({ id: "quota", label: "Codex CLI 检测失败", detail: String(error), state: "warning", action: { label: "重试", run: refreshCodexCli } });
  }
}

async function installCodexCli(): Promise<void> {
  update({ id: "quota", label: "正在安装 Codex CLI", detail: "正在通过 npm 下载并安装，请稍候", state: "checking" });
  try {
    const status = await invoke<CodexCliStatus>("install_codex_cli");
    applyCodexCliStatus(status);
  } catch (error) {
    update({
      id: "quota",
      label: "Codex CLI 安装失败",
      detail: String(error),
      state: "warning",
      action: { label: "重试", run: installCodexCli },
    });
  }
}

async function installHooks(): Promise<void> {
  update({ id: "hooks", label: "Codex Hooks", detail: "正在安装", state: "checking" });
  try {
    await invoke("install_codex_status_hooks");
    update({ id: "hooks", label: "Codex Hooks", detail: "已安装，重启 Codex 后生效", state: "ready" });
  } catch (error) {
    update({ id: "hooks", label: "Codex Hooks 尚未安装", detail: String(error), state: "warning", action: { label: "重试", run: installHooks } });
  }
}

async function runChecks(): Promise<void> {
  const generation = ++checkGeneration;
  items = checkingItems();
  render();
  update({ id: "runtime", label: "Wisland 运行环境", detail: "运行正常", state: "ready" });
  const [platformResult, cliResult, settingsResult] = await Promise.allSettled([
    invoke<PlatformStatus>("get_environment_platform_status"),
    invoke<CodexCliStatus>("get_codex_cli_status"),
    invoke<CoreSettings>("get_settings"),
  ]);
  if (generation !== checkGeneration || !active) return;

  if (platformResult.status === "fulfilled") {
    const platform = platformResult.value;
    update({ id: "webview", label: "WebView2", detail: `可用 · ${platform.webview2Version}`, state: "ready" });
    update({
      id: "desktop",
      label: "Codex Desktop",
      detail: platform.codexDesktopRunning ? "已安装并正在运行" : platform.codexDesktopInstalled ? "已安装，当前未运行" : "未检测到安装",
      state: platform.codexDesktopInstalled ? "ready" : "warning",
    });
    update(platform.codexHooksInstalled
      ? { id: "hooks", label: "Codex Hooks", detail: "已安装", state: "ready" }
      : { id: "hooks", label: "Codex Hooks 尚未安装", detail: "用于显示 Codex 任务状态", state: "warning", action: { label: "安装", run: installHooks } });
  } else {
    update({ id: "webview", label: "WebView2", detail: String(platformResult.reason), state: "warning" });
    update({ id: "desktop", label: "Codex Desktop", detail: "检测失败", state: "warning" });
    update({ id: "hooks", label: "Codex Hooks", detail: "检测失败", state: "warning", action: { label: "安装", run: installHooks } });
  }

  if (settingsResult.status === "fulfilled" && settingsResult.value.obsidian_vault_path?.trim()) {
    update({ id: "obsidian", label: "Obsidian", detail: "已配置 Vault", state: "ready" });
  } else {
    update({
      id: "obsidian",
      label: "Obsidian 尚未配置",
      detail: "可稍后在设置中配置",
      state: "warning",
      action: { label: "设置", run: async () => { await invoke("open_settings_page", { page: "obsidian" }); } },
    });
  }

  if (cliResult.status === "fulfilled") {
    applyCodexCliStatus(cliResult.value);
  } else {
    update({
      id: "quota",
      label: "Codex CLI 检测失败",
      detail: String(cliResult.reason),
      state: "warning",
      action: { label: "重试", run: refreshCodexCli },
    });
  }
  void scanPlayer();
}

function startCompactRotation(): void {
  window.clearInterval(compactTimer);
  compactTimer = window.setInterval(() => {
    if (!active) return;
    compactIndex = (compactIndex + 1) % order.length;
    renderCompact(true);
  }, 5_000);
}

function activate(): void {
  active = true;
  compactIndex = 0;
  capsule.classList.add("environment-check");
  capsule.classList.remove("environment-state-pending");
  environmentCheckArea.hidden = false;
  environmentCheckFull.setAttribute("aria-hidden", String(!capsule.classList.contains("expanded")));
  startCompactRotation();
  void runChecks();
}

function deactivate(): void {
  const wasActive = active;
  active = false;
  checkGeneration += 1;
  window.clearInterval(compactTimer);
  window.cancelAnimationFrame(heightFrame);
  window.clearTimeout(heightResizeTimer);
  setSkipResizeSync(false);
  capsule.classList.remove("environment-check", "environment-state-pending");
  environmentCheckArea.hidden = true;
  if (wasActive) window.dispatchEvent(new CustomEvent("wisland-environment-check-finished"));
}

export async function initEnvironmentCheck(): Promise<void> {
  new ResizeObserver(scheduleEnvironmentHeight).observe(environmentCheckFull);
  new MutationObserver(() => {
    const expanded = capsule.classList.contains("expanded");
    environmentCheckFull.setAttribute("aria-hidden", String(!expanded));
    scheduleEnvironmentHeight();
  }).observe(capsule, { attributes: true, attributeFilter: ["class"] });
  environmentRefresh.addEventListener("click", (event) => {
    event.stopPropagation();
    void runChecks();
  });
  environmentSkip.addEventListener("click", async (event) => {
    event.stopPropagation();
    environmentSkip.disabled = true;
    try {
      await invoke("complete_environment_check");
      deactivate();
    } finally {
      environmentSkip.disabled = false;
    }
  });
  await listen("environment-check-start", activate);
  await listen("environment-check-finished", deactivate);
  try {
    if (await invoke<boolean>("get_environment_check_active")) activate();
    else deactivate();
  } catch (error) {
    console.warn("Failed to initialize environment check", error);
    deactivate();
  }
}
