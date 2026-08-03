import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setLyricMode, skipResizeSync } from "../state";
import { applyIndicatorColor } from "./minimize-drag";

let lastHeight = 0;
let syncFrame = 0;

function syncHeightNow(): void {
  if (skipResizeSync) return;
  const height = document.documentElement.offsetHeight;
  if (height <= 0 || height === lastHeight) return;
  lastHeight = height;
  void invoke("sync_window_height", { height });
}

function syncHeight(): void {
  if (syncFrame) cancelAnimationFrame(syncFrame);
  syncFrame = requestAnimationFrame(() => {
    syncFrame = 0;
    syncHeightNow();
  });
}

export function initResizeObserver(): void {
  new ResizeObserver(syncHeight).observe(document.documentElement);

  void invoke<{ lyric_mode?: string; indicator_color?: string }>("get_settings")
    .then((settings) => {
      if (settings.lyric_mode) setLyricMode(settings.lyric_mode);
      if (settings.indicator_color) applyIndicatorColor(settings.indicator_color);
    })
    .catch((error) => console.warn("Failed to load Wisland settings", error));

  void listen<string>("indicator-color-changed", (event) => applyIndicatorColor(event.payload));
  void listen<string>("lyric-mode-changed", (event) => setLyricMode(event.payload));
  void listen("request-size-sync", syncHeight);
  syncHeight();
}
