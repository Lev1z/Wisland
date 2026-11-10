// 歌词补偿·按播放器（二级子页）逻辑
// 负责：加载/展示各播放器补偿、± 即时保存、自动发现新播放器、主副两处总开关同步。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type PlayerOffsetEntry = {
  app_id: string;
  ms: number;
};

type LyricOffsetState = {
  enabled: boolean;
  active_app_id: string | null;
  min_ms: number;
  max_ms: number;
  step_ms: number;
  players: PlayerOffsetEntry[];
};

const DEFAULT_STEP_MS = 500;
const DEFAULT_MIN_MS = -3000;
const DEFAULT_MAX_MS = 3000;

type Refs = {
  mainToggle: HTMLInputElement | null;
  subToggle: HTMLInputElement | null;
  listEl: HTMLDivElement | null;
  emptyEl: HTMLDivElement | null;
  statusEl: HTMLSpanElement | null;
};

const state = {
  enabled: true,
  activeAppId: null as string | null,
  minMs: DEFAULT_MIN_MS,
  maxMs: DEFAULT_MAX_MS,
  stepMs: DEFAULT_STEP_MS,
  players: [] as PlayerOffsetEntry[],
};

function formatMs(ms: number): string {
  return `${ms > 0 ? "+" : ""}${ms / 1000} 秒`;
}

function playerName(appId: string): string {
  const id = appId.toLowerCase();
  const names: Record<string, string> = {
    "cloudmusic.exe": "网易云音乐", "qqmusic.exe": "QQ 音乐",
    "kugou": "酷狗音乐", "kugou.exe": "酷狗音乐", "汽水音乐": "汽水音乐",
  };
  if (id.startsWith("microsoft.zunemusic_")) return "Windows 媒体播放器";
  if (id.startsWith("appleinc.applemusicwin_")) return "Apple Music";
  return names[id] ?? appId;
}

function clampToRange(ms: number): number {
  const step = state.stepMs || DEFAULT_STEP_MS;
  const min = state.minMs ?? DEFAULT_MIN_MS;
  const max = state.maxMs ?? DEFAULT_MAX_MS;
  const clamped = Math.min(max, Math.max(min, ms));
  // 向最近 step 取整
  return Math.round(clamped / step) * step;
}

function setSubpageStatus(refs: Refs, text: string, durationMs = 2000) {
  if (!refs.statusEl) return;
  refs.statusEl.textContent = text;
  if (durationMs > 0) {
    const current = text;
    setTimeout(() => {
      if (refs.statusEl && refs.statusEl.textContent === current) {
        refs.statusEl.textContent = "";
      }
    }, durationMs);
  }
}

function syncToggles(refs: Refs) {
  if (refs.mainToggle) refs.mainToggle.checked = state.enabled;
  if (refs.subToggle) refs.subToggle.checked = state.enabled;
}

function renderList(refs: Refs) {
  if (!refs.listEl || !refs.emptyEl) return;
  refs.listEl.innerHTML = "";

  if (state.players.length === 0) {
    refs.emptyEl.style.display = "block";
    return;
  }
  refs.emptyEl.style.display = "none";

  for (const entry of state.players) {
    refs.listEl.appendChild(buildRow(refs, entry));
  }
}

function buildRow(refs: Refs, entry: PlayerOffsetEntry): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface);border-radius:8px;gap:12px;";

  const label = document.createElement("div");
  label.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;flex:1;";
  const name = document.createElement("span");
  name.textContent = playerName(entry.app_id);
  name.title = entry.app_id;
  name.style.cssText = "font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  label.appendChild(name);
  if (state.activeAppId && entry.app_id === state.activeAppId) {
    const badge = document.createElement("span");
    badge.textContent = "当前";
    badge.style.cssText =
      "font-size:11px;padding:2px 8px;border-radius:10px;background:var(--primary);color:#fff;";
    label.appendChild(badge);
  }

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;align-items:center;gap:8px;";

  const minusBtn = document.createElement("button");
  minusBtn.type = "button";
  minusBtn.className = "btn btn-small";
  minusBtn.textContent = `− ${state.stepMs / 1000} 秒`;
  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.className = "btn btn-small";
  plusBtn.textContent = `+ ${state.stepMs / 1000} 秒`;
  const value = document.createElement("span");
  value.textContent = formatMs(entry.ms);
  value.style.cssText = "min-width:80px;text-align:center;font-variant-numeric:tabular-nums;";

  const applyDisabledByRange = (nextMs: number) => {
    minusBtn.disabled = nextMs <= state.minMs;
    plusBtn.disabled = nextMs >= state.maxMs;
  };
  applyDisabledByRange(entry.ms);

  const adjust = async (delta: number) => {
    const next = clampToRange(entry.ms + delta);
    if (next === entry.ms) return;
    const prev = entry.ms;
    entry.ms = next;
    value.textContent = formatMs(next);
    applyDisabledByRange(next);
    minusBtn.disabled = true;
    plusBtn.disabled = true;
    try {
      const applied = await invoke<number>("set_lyric_offset_for_player", {
        appId: entry.app_id,
        ms: next,
      });
      if (applied !== next) {
        entry.ms = applied;
        value.textContent = formatMs(applied);
      }
      setSubpageStatus(refs, `${playerName(entry.app_id)}：${formatMs(applied)}`);
    } catch (e) {
      entry.ms = prev;
      value.textContent = formatMs(prev);
      setSubpageStatus(refs, `保存失败: ${String(e)}`, 4000);
    } finally {
      applyDisabledByRange(entry.ms);
    }
  };

  minusBtn.addEventListener("click", () => void adjust(-state.stepMs));
  plusBtn.addEventListener("click", () => void adjust(state.stepMs));

  controls.appendChild(minusBtn);
  controls.appendChild(value);
  controls.appendChild(plusBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "btn btn-small";
  delBtn.textContent = "移除";
  delBtn.style.color = "var(--danger, #ff6f7f)";
  delBtn.title = "从列表移除该播放器的配置";
  delBtn.addEventListener("click", async () => {
    delBtn.disabled = true;
    try {
      await invoke("delete_lyric_offset_player", { appId: entry.app_id });
      state.players = state.players.filter((p) => p.app_id !== entry.app_id);
      renderList(refs);
      setSubpageStatus(refs, `${playerName(entry.app_id)} 已移除`);
    } catch (e) {
      setSubpageStatus(refs, `删除失败: ${String(e)}`, 4000);
    } finally {
      delBtn.disabled = false;
    }
  });
  controls.appendChild(delBtn);

  row.appendChild(label);
  row.appendChild(controls);
  return row;
}

async function reload(refs: Refs) {
  try {
    const resp = await invoke<LyricOffsetState>("get_lyric_offset_players");
    state.enabled = !!resp.enabled;
    state.activeAppId = resp.active_app_id ?? null;
    state.minMs = Number.isFinite(resp.min_ms) ? resp.min_ms : DEFAULT_MIN_MS;
    state.maxMs = Number.isFinite(resp.max_ms) ? resp.max_ms : DEFAULT_MAX_MS;
    state.stepMs = Number.isFinite(resp.step_ms) && resp.step_ms > 0 ? resp.step_ms : DEFAULT_STEP_MS;
    state.players = Array.isArray(resp.players)
      ? resp.players
          .filter((p) => p && typeof p.app_id === "string")
          .map((p) => ({ app_id: p.app_id, ms: Number(p.ms) || 0 }))
      : [];
    syncToggles(refs);
    renderList(refs);
  } catch (e) {
    setSubpageStatus(refs, `加载失败: ${String(e)}`, 4000);
  }
}

async function handleToggleChange(refs: Refs, enabled: boolean) {
  state.enabled = enabled;
  syncToggles(refs);
  try {
    await invoke("set_lyric_offset_enabled", { enabled });
    setSubpageStatus(refs, enabled ? "歌词补偿已启用" : "歌词补偿已禁用");
  } catch (e) {
    // 回滚
    state.enabled = !enabled;
    syncToggles(refs);
    setSubpageStatus(refs, `切换失败: ${String(e)}`, 4000);
  }
}

export function initLyricOffset(): void {
  const refs: Refs = {
    mainToggle: document.getElementById("lyric-offset-enabled") as HTMLInputElement | null,
    subToggle: document.getElementById("lyric-offset-enabled-sub") as HTMLInputElement | null,
    listEl: document.getElementById("lyric-offset-list") as HTMLDivElement | null,
    emptyEl: document.getElementById("lyric-offset-empty") as HTMLDivElement | null,
    statusEl: document.getElementById("lyric-offset-status") as HTMLSpanElement | null,
  };

  if (refs.mainToggle) {
    refs.mainToggle.addEventListener("change", () => {
      void handleToggleChange(refs, refs.mainToggle!.checked);
    });
  }
  if (refs.subToggle) {
    refs.subToggle.addEventListener("change", () => {
      void handleToggleChange(refs, refs.subToggle!.checked);
    });
  }

  void reload(refs);

  // 后端：新播放器入表 / 活跃播放器变化时刷新
  void listen<{ new_app_id?: string }>("lyric-offset-players-changed", () => {
    void reload(refs);
  });
  void listen<{ app_id?: string }>("lyric-offset-active-player-changed", (evt) => {
    state.activeAppId = evt.payload?.app_id ?? null;
    // 只重渲染列表（不改变 players 顺序/值）
    renderList(refs);
  });
}
