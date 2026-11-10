import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./theme.css";

type ThemeSettings = {
  theme?: string;
  borderEffect?: string; border_effect?: string;
  borderCustomSource?: string; border_custom_source?: string;
  borderAssets?: { id: string; data_url?: string; dataUrl?: string }[];
  border_assets?: { id: string; data_url?: string; dataUrl?: string }[];
};
type Material = { acrylic: boolean; dark: boolean; motion: boolean };

export function initTheme(surface: "capsule" | "settings" | "sidebar"): void {
  const root = document.documentElement;
  root.dataset.surface = surface;
  let generation = 0;
  let glass = false;
  let frame = 0;
  let followUntil = 0;
  let lastBounds = "";
  const capsule = surface === "capsule" ? document.getElementById("island-capsule") : null;
  const clip = async () => {
    if (!capsule || !glass) return;
    const outline = document.body.classList.contains("minimized") ? document.getElementById("collapsed-indicator") : capsule;
    if (!outline) return;
    const rect = outline.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scale = rect.width / Math.max(1, outline.offsetWidth);
    const radius = Math.min(rect.width / 2, rect.height / 2, parseFloat(getComputedStyle(outline).borderTopLeftRadius) * scale || 0);
    const bounds = [rect.x, rect.y, rect.width, rect.height, radius].map(n => Math.round(n * 100) / 100);
    const key = `${devicePixelRatio}:${bounds}`;
    if (key === lastBounds) return;
    await invoke("sync_capsule_theme_clip", { bounds });
    lastBounds = key;
  };
  const follow = () => {
    if (!capsule || !glass || frame) return;
    frame = requestAnimationFrame(async () => {
      try { await clip(); } catch (error) { console.warn("同步胶囊材质轮廓失败", error); }
      finally {
        frame = 0;
        if (glass && performance.now() < followUntil) follow();
      }
    });
  };
  if (capsule) {
    new ResizeObserver(follow).observe(capsule);
    new MutationObserver(() => { followUntil = performance.now() + 800; follow(); }).observe(capsule, { attributes: true, attributeFilter: ["class", "style"] });
    new MutationObserver(() => { followUntil = performance.now() + 800; follow(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const indicator = document.getElementById("collapsed-indicator");
    if (indicator) new ResizeObserver(follow).observe(indicator);
    for (const outline of [capsule, indicator]) {
      if (!outline) continue;
      for (const event of ["transitionrun", "animationstart", "transitionend", "animationend"]) {
        outline.addEventListener(event, e => { if (e.target === outline) { followUntil = performance.now() + 800; follow(); } });
      }
    }
    window.addEventListener("resize", follow);
  }
  const apply = async (settings: ThemeSettings) => {
    const id = ++generation;
    const border = settings.borderEffect ?? settings.border_effect ?? "off";
    const theme = settings.theme === "glass" || (!settings.theme && border === "glass") ? "glass" : "dark";
    glass = theme === "glass";
    if (glass) await clip();
    const material = await invoke<Material>("get_window_theme");
    if (id !== generation) return;
    glass = theme === "glass" && material.acrylic;
    root.dataset.wislandTheme = theme;
    root.dataset.borderEffect = ["aurora", "mono"].includes(border) ? border : "off";
    root.dataset.acrylic = String(material.acrylic);
    root.dataset.theme = material.dark ? "dark" : "light";
    if (capsule) {
      if (!glass) { await invoke("sync_capsule_theme_clip", { bounds: null }); lastBounds = ""; }
      else { followUntil = performance.now() + 800; follow(); }
    }
  };
  void (async () => {
    // Subscribe before loading so a settings change cannot be missed during startup.
    await listen<ThemeSettings>("appearance-changed", ({ payload }) => { void apply(payload).catch(console.error); });
    const start = generation;
    const settings = await invoke<ThemeSettings>("get_settings");
    if (start === generation) await apply(settings);
  })().catch(error => console.error("加载主题失败", error));
}
