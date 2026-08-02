import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule } from "../dom";
import { setLyricMode, skipResizeSync } from "../state";
import { applyIndicatorColor } from "./minimize-drag";

let lastHeight = 0;

function syncHeight(): void {
  if (skipResizeSync) return;
  const height = document.documentElement.offsetHeight;
  if (height <= 0 || height === lastHeight) return;
  lastHeight = height;
  void invoke("sync_window_height", { height });
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
  capsule.addEventListener("transitionend", syncHeight);
  syncHeight();
}
