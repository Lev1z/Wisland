import { invoke } from "@tauri-apps/api/core";

type CodexCliStatus = {
  ready: boolean;
  desktopInstalled: boolean;
  connectable: boolean;
  source?: string;
  message: string;
};

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

type OnboardingStatus = {
  runtimeOk: boolean;
  webview2Version?: string;
  codexDesktopRunning: boolean;
  codexCli: CodexCliStatus;
  hooksInstalled: boolean;
  smtcSessions: SmtcSession[];
  smtcError?: string;
  obsidianConfigured: boolean;
};

type CodexQuota = {
  available: boolean;
  remainingPercent?: number;
  message?: string;
  source?: string;
};

type CheckTone = "ok" | "pending" | "missing";
type CheckAction = { label: string; run: (button: HTMLButtonElement) => Promise<void> };

const list = document.getElementById("check-list")!;
const summary = document.getElementById("summary")!;
const refreshButton = document.getElementById("refresh") as HTMLButtonElement;
const enterButton = document.getElementById("enter") as HTMLButtonElement;
const skipButton = document.getElementById("skip") as HTMLButtonElement;

let current: OnboardingStatus | null = null;
let quota: CodexQuota | null = null;

function makeRow(title: string, detail: string, tone: CheckTone, action?: CheckAction): HTMLElement {
  const row = document.createElement("article");
  row.className = `check-row ${tone}`;
  row.style.setProperty("--index", String(list.children.length));

  const icon = document.createElement("span");
  icon.className = "check-icon";
  icon.textContent = tone === "ok" ? "✓" : tone === "pending" ? "!" : "×";
  const copy = document.createElement("span");
  copy.className = "check-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  copy.append(strong, small);
  row.append(icon, copy);

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "check-action";
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action.run(button);
      } catch (error) {
        summary.textContent = String(error);
      } finally {
        button.disabled = false;
      }
    });
    row.append(button);
  }
  return row;
}

function playerRow(status: OnboardingStatus): HTMLElement {
  const eligible = status.smtcSessions.filter((session) => session.eligible && session.readable);
  const tone: CheckTone = eligible.length ? "ok" : status.smtcSessions.length ? "pending" : "missing";
  const detail = eligible.length
    ? `已找到 ${eligible.length} 个可用播放器会话`
    : status.smtcError
      ? status.smtcError
      : status.smtcSessions.length
        ? "已检测到媒体会话，但尚未放行可用播放器"
        : "未检测到会话；请播放一首音乐后重新检测";
  const row = makeRow("播放器（SMTC）", detail, tone, {
    label: "重新扫描",
    run: async () => refresh(),
  });
  const copy = row.querySelector<HTMLElement>(".check-copy")!;
  if (status.smtcSessions.length) {
    const sessions = document.createElement("span");
    sessions.className = "session-list";
    for (const session of status.smtcSessions) {
      const chip = document.createElement("span");
      chip.className = `session-chip${session.eligible ? " accepted" : ""}`;
      const label = session.title || session.artist
        ? `${session.title || "未知曲目"} · ${session.appId}`
        : session.appId || "未知会话";
      chip.title = `${label} (${session.playbackStatus})`;
      chip.append(document.createTextNode(label));
      if (!session.eligible && session.appId) {
        const allow = document.createElement("button");
        allow.type = "button";
        allow.textContent = "放行";
        allow.addEventListener("click", async () => {
          allow.disabled = true;
          try {
            const values = await invoke<string[]>("get_smtc_whitelist");
            const normalized = session.appId.toLowerCase();
            if (!values.some((value) => normalized.includes(value.toLowerCase()))) values.push(session.appId);
            await invoke("save_smtc_whitelist", { appIds: values });
            await invoke("set_smtc_whitelist_enabled", { enabled: true });
            await refresh();
          } finally {
            allow.disabled = false;
          }
        });
        chip.append(allow);
      }
      sessions.append(chip);
    }
    copy.append(sessions);
  }
  return row;
}

function render(status: OnboardingStatus): void {
  const codexDesktopInstalled = status.codexCli.desktopInstalled || status.codexDesktopRunning;
  list.replaceChildren();
  list.append(makeRow("Wisland 运行环境", "应用核心与本地配置目录可用", status.runtimeOk ? "ok" : "missing"));
  list.append(makeRow(
    "Microsoft WebView2",
    status.webview2Version ? `运行时版本 ${status.webview2Version}` : "当前 WebView2 正常运行",
    "ok",
  ));
  list.append(makeRow(
    "Codex Desktop",
    codexDesktopInstalled
      ? status.codexDesktopRunning ? "已安装，当前正在运行" : "已安装，当前未运行"
      : "未检测到 Codex Desktop",
    codexDesktopInstalled ? "ok" : "missing",
  ));
  list.append(makeRow(
    "Codex 状态 Hooks",
    status.hooksInstalled ? "已连接任务开始与完成状态" : "尚未安装，可一键写入 Wisland 管理区块",
    status.hooksInstalled ? "ok" : "pending",
    status.hooksInstalled ? undefined : {
      label: "一键安装",
      run: async () => {
        await invoke("install_codex_status_hooks");
        await refresh();
      },
    },
  ));

  const quotaReady = quota?.available === true;
  const quotaDetail = quotaReady
    ? `已连接${quota?.source ? ` · ${quota.source}` : ""}${quota?.remainingPercent != null ? ` · 剩余 ${Math.round(quota.remainingPercent)}%` : ""}`
    : quota?.message || status.codexCli.message;
  list.append(makeRow(
    "Codex 额度服务",
    quotaDetail,
    quotaReady ? "ok" : status.codexCli.connectable ? "pending" : "missing",
    status.codexCli.connectable ? {
      label: quotaReady ? "重新验证" : "连接",
      run: async (button) => {
        button.textContent = "连接中…";
        quota = await invoke<CodexQuota>("connect_codex_quota");
        render(status);
      },
    } : undefined,
  ));
  list.append(playerRow(status));
  list.append(makeRow(
    "Obsidian 随手记",
    status.obsidianConfigured ? "Vault 路径有效" : "尚未配置，可稍后在设置中填写",
    status.obsidianConfigured ? "ok" : "pending",
  ));

  const essentials = [
    status.runtimeOk,
    codexDesktopInstalled,
    status.hooksInstalled,
    quotaReady,
    status.smtcSessions.some((session) => session.eligible && session.readable),
  ];
  summary.textContent = `关键连接 ${essentials.filter(Boolean).length}/${essentials.length} · 未完成项目不影响进入`;
}

async function refresh(): Promise<void> {
  refreshButton.disabled = true;
  summary.textContent = "正在检测本机环境…";
  try {
    current = await invoke<OnboardingStatus>("get_onboarding_status");
    render(current);
  } catch (error) {
    summary.textContent = `检测失败：${String(error)}`;
  } finally {
    refreshButton.disabled = false;
  }
}

async function complete(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await invoke("complete_onboarding");
  } catch (error) {
    summary.textContent = `无法进入：${String(error)}`;
    button.disabled = false;
  }
}

refreshButton.addEventListener("click", () => void refresh());
enterButton.addEventListener("click", () => void complete(enterButton));
skipButton.addEventListener("click", () => void complete(skipButton));
void refresh();
