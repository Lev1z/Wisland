import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
type Status = { autoCheck: boolean; phase: string; version: string | null; notes: string; error: string | null; downloaded: number; total: number | null; checkedAt: number };
export async function initUpdater(): Promise<void> {
  const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const check = el<HTMLButtonElement>("update-check"), install = el<HTMLButtonElement>("update-install"), auto = el<HTMLInputElement>("update-auto");
  const dialog = el<HTMLDialogElement>("update-confirm"), progress = el<HTMLProgressElement>("update-progress");
  const details = el<HTMLDialogElement>("update-details");
  let state: Status | null = null, confirmed: string | null = null;
  let lastFailure = "";
  const showFailure = (message: string, key: string) => {
    el("update-details-title").textContent = "更新失败";
    el("update-detail-status").textContent = message;
    el("update-notes").hidden = true;
    if (dialog.open) { dialog.close(); confirmed = null; }
    if (key !== lastFailure) {
      lastFailure = key;
      if (!details.open) details.showModal();
    }
  };
  const render = (next: Status): void => {
    state = next; auto.checked = next.autoCheck;
    const busy = ["checking", "downloading", "verifying", "installing"].includes(next.phase);
    check.disabled = busy; check.hidden = next.phase === "available"; install.hidden = next.phase !== "available";
    const labels: Record<string, string> = { idle: "尚未检查更新", checking: "正在检查更新…", current: "当前已是最新稳定版本", available: `发现新版本 ${next.version ?? ""}`, downloading: "正在下载更新…", verifying: "正在校验更新签名…", installing: "正在启动安装程序，Wisland 将退出…", error: "检查或更新失败" };
    const percent = next.total && next.total > 0 ? ` ${Math.min(100, Math.floor(next.downloaded / next.total * 100))}%` : "";
    el("update-message").textContent = next.phase === "downloading" ? `下载中${percent}` : labels[next.phase] ?? "";
    el("update-message").hidden = next.phase === "idle" || next.phase === "error";
    el("update-message").title = "查看更新说明与详情";
    el("update-details-title").textContent = "更新详情";
    el("update-detail-status").textContent = next.error ?? labels[next.phase] ?? "更新状态未知";
    el("update-notes").textContent = next.notes;
    el("update-notes").hidden = !next.notes;
    const date = new Date(next.checkedAt * 1000);
    el("update-checked").textContent = next.checkedAt ? `上次检查：${date.toDateString() === new Date().toDateString() ? "今天" : date.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })} ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}` : "尚未检查";
    progress.hidden = next.phase !== "downloading";
    if (next.total && next.total > 0) { progress.max = next.total; progress.value = next.downloaded; } else progress.removeAttribute("value");
    if (dialog.open && next.phase !== "available") { dialog.close(); confirmed = null; }
    if (next.error || next.phase === "error") showFailure(next.error ?? "检查或更新失败", `${next.checkedAt}:${next.error ?? next.phase}`);
    else lastFailure = "";
  };
  const error = (value: unknown): void => { el("update-message").hidden = true; showFailure(String(value), `${state?.checkedAt ?? 0}:${String(value)}`); };
  el("update-message").addEventListener("click", () => { if (!details.open) details.showModal(); });
  el("update-details-close").addEventListener("click", () => details.close());
  el("update-manual").addEventListener("click", () => { void invoke("open_update_release").catch(error); });
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
