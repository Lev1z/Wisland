import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type QuotaWindow = { remainingPercent: number; resetsAt: number | null };
type Snapshot = {
  quota: { available: boolean; fiveHour: QuotaWindow | null; weekly: QuotaWindow | null; message: string | null };
  phase: string;
  stale: boolean;
  updatedAt: number | null;
};
type Appearance = { acrylic: boolean; dark: boolean; motion: boolean };

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const feedback = el("feedback");
let snapshot: Snapshot | null = null;
let refreshing = false;

function applyAppearance(value: Appearance): void {
  document.documentElement.dataset.acrylic = String(value.acrylic);
  document.documentElement.dataset.theme = value.dark ? "dark" : "light";
  document.documentElement.dataset.motion = String(value.motion);
}
// Rust moves the complete native surface. Never fade/translate the contents separately
// from the acrylic background (or animate a cached Windows non-client frame).

const phases: Record<string, [string, string]> = {
  running: ["Running", "#f3a52b"], idle: ["Idle", "#79dd18"],
  completed: ["Idle", "#79dd18"], failed: ["Offline", "#747982"], stale: ["Offline", "#747982"],
};
const percent = (quota: QuotaWindow | null) => quota ? `${Math.round(Math.max(0, Math.min(100, quota.remainingPercent)))}%` : "--%";

function resetLabel(quota: QuotaWindow | null): string {
  if (!quota) return "等待额度数据";
  if (!quota.resetsAt) return "重置时间不可用";
  const minutes = Math.ceil((quota.resetsAt * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return "等待额度重置";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
}

function render(value: Snapshot): void {
  snapshot = value;
  const [phase, color] = phases[value.phase] ?? phases.stale;
  document.documentElement.style.setProperty("--status", color);
  el("phase").textContent = phase;
  const { quota } = value;
  // A missing window on a successful response means no reported limit, not 0%.
  const rows: [string, QuotaWindow | null][] = [];
  if (!quota.available || quota.fiveHour) rows.push(["5-hour", quota.fiveHour]);
  if (!quota.available || quota.weekly) rows.push(["Weekly", quota.weekly]);
  // Keep content geometry fixed while the native viewport reveals/hides it.
  el("details").style.height = `${144 + Math.max(1, rows.length) * 80}px`;

  el("quota-rows").replaceChildren(...rows.map(([name, data]) => {
    const row = document.createElement("div");
    row.className = "quota-row";
    const heading = document.createElement("div");
    heading.className = "quota-row-heading";
    const label = document.createElement("span");
    label.textContent = name;
    const number = document.createElement("strong");
    number.textContent = percent(data);
    heading.append(label, number);
    const track = document.createElement("div");
    track.className = "progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", `${name} 剩余额度`);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    if (data) track.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, data.remainingPercent))));
    const bar = document.createElement("div");
    bar.className = "progress-value";
    bar.style.width = data ? percent(data) : "0%";
    track.append(bar);
    const reset = document.createElement("div");
    reset.className = "reset";
    reset.textContent = resetLabel(data);
    if (data?.resetsAt) reset.title = new Date(data.resetsAt * 1000).toLocaleString();
    row.append(heading, track, reset);
    return row;
  }));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "当前账户未返回 5h / 1w 额度窗口";
    el("quota-rows").append(empty);
  }
  if (!refreshing) feedback.textContent = value.stale ? "上次成功数据" : quota.available ? "" : "额度暂不可用";
  feedback.title = value.stale ? "连接失败，展示上次成功数据；最长保留 6 小时" : quota.message ?? "";
}

async function command(name: string, args?: Record<string, unknown>): Promise<void> {
  try { await invoke(name, args); }
  catch (error) { feedback.textContent = "操作失败"; feedback.title = String(error); console.error(error); }
}

el("settings").addEventListener("click", () => void command("open_settings"));
el("restore").addEventListener("click", () => void command("set_display_mode", { mode: "capsule" }));
el<HTMLButtonElement>("refresh").addEventListener("click", async () => {
  if (refreshing) return;
  refreshing = true;
  el<HTMLButtonElement>("refresh").disabled = true;
  feedback.textContent = "正在刷新…";
  try { render(await invoke<Snapshot>("refresh_tray_quota")); }
  catch (error) { feedback.textContent = "刷新失败"; feedback.title = String(error); }
  finally { refreshing = false; el<HTMLButtonElement>("refresh").disabled = false; if (snapshot) render(snapshot); }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void command("set_tray_expanded", { expanded: false });
});
window.addEventListener("contextmenu", (event) => event.preventDefault());

async function init(): Promise<void> {
  await listen<Appearance>("tray-appearance", ({ payload }) => applyAppearance(payload));
  await listen<Snapshot>("tray-snapshot", ({ payload }) => render(payload));
  await listen<boolean>("tray-expanded", ({ payload }) => {
    if (payload) el("details").focus({ preventScroll: true });
  });
  applyAppearance(await invoke<Appearance>("get_tray_appearance"));
  render(await invoke<Snapshot>("get_tray_snapshot"));
}
void init().catch(console.error);
window.setInterval(() => { if (snapshot) render(snapshot); }, 60_000);
