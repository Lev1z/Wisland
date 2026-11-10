import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
type Status = { autoCheck: boolean; phase: string; version: string | null; notes: string; error: string | null; downloaded: number; total: number | null; checkedAt: number };
export async function initUpdater(): Promise<void> {
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const check = el<HTMLButtonElement>("update-check"), install = el<HTMLButtonElement>("update-install"), auto = el<HTMLInputElement>("update-auto");
  const dialog = el<HTMLDialogElement>("update-confirm"), progress = el<HTMLProgressElement>("update-progress");
  let state: Status | null = null, confirmed: string | null = null;
  const render = (next: Status): void => {
    state = next; auto.checked = next.autoCheck;
    const busy = ["checking", "downloading", "verifying", "installing"].includes(next.phase);
    check.disabled = busy; install.hidden = next.phase !== "available";
    const labels: Record<string, string> = { idle: "尚未检查更新", checking: "正在检查更新…", current: "当前已是最新稳定版本", available: `发现新版本 ${next.version ?? ""}`, downloading: "正在下载更新…", verifying: "正在校验更新签名…", installing: "正在启动安装程序，Wisland 将退出…", error: "检查或更新失败" };
    el("update-message").textContent = next.error ?? labels[next.phase] ?? "更新状态未知";
    el("update-notes").textContent = next.notes;
    el("update-notes").hidden = !next.notes;
    el("update-checked").textContent = next.checkedAt ? `最近检查：${new Date(next.checkedAt * 1000).toLocaleString()}` : "";
    progress.hidden = next.phase !== "downloading";
    if (next.total && next.total > 0) { progress.max = next.total; progress.value = next.downloaded; } else progress.removeAttribute("value");
    if (dialog.open && next.phase !== "available") { dialog.close(); confirmed = null; }
  };
  const error = (value: unknown): void => { el("update-message").textContent = String(value); };
  check.addEventListener("click", () => { check.disabled = true; void invoke<Status>("check_update").then(render).catch(error).finally(() => { check.disabled = false; }); });
  auto.addEventListener("change", () => { auto.disabled = true; void invoke<Status>("set_auto_update_check", { enabled: auto.checked }).then(render).catch(e => { auto.checked = state?.autoCheck ?? true; error(e); }).finally(() => { auto.disabled = false; }); });
  install.addEventListener("click", () => {
    if (state?.phase !== "available" || !state.version) return;
    confirmed = state.version; el("update-confirm-text").textContent = `下载并安装 Wisland ${confirmed}？签名校验通过后将退出 Wisland 并运行安装程序。Codex 和其他应用不会退出。`;
    dialog.showModal();
  });
  el("update-cancel").addEventListener("click", () => { confirmed = null; dialog.close(); });
  el("update-confirm-install").addEventListener("click", () => {
    const version = confirmed; confirmed = null; dialog.close();
    if (!version || state?.phase !== "available" || state.version !== version) return;
    install.disabled = true; check.disabled = true;
    void invoke("install_update", { confirmedVersion: version }).catch(error).finally(() => { install.disabled = false; check.disabled = false; });
  });
  dialog.addEventListener("cancel", () => { confirmed = null; });
  await listen<Status>("update-status", event => render(event.payload));
  render(await invoke<Status>("get_update_status"));
}
