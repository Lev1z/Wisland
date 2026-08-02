import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule } from "../dom";

type Appearance = {
  capsule_opacity?: number;
  capsule_scale?: number;
  rainbow_border?: boolean;
  opacity?: number;
  scale?: number;
  rainbowBorder?: boolean;
};

const dimensions = {
  "--collapsed-w": 140,
  "--collapsed-h": 50,
  "--lyric-collapsed-w": 190,
  "--journal-collapsed-w": 250,
  "--tray-collapsed-w": 190,
  "--expanded-w": 330,
  "--expanded-h": 74,
} as const;

function applyAppearance(settings: Appearance): void {
  const opacity = Math.max(0.6, Math.min(1, settings.opacity ?? settings.capsule_opacity ?? 1));
  const scale = Math.max(0.9, Math.min(1.15, settings.scale ?? settings.capsule_scale ?? 1));
  const rainbow = settings.rainbowBorder ?? settings.rainbow_border ?? false;
  for (const [property, value] of Object.entries(dimensions)) {
    document.documentElement.style.setProperty(property, `${value * scale}px`);
  }
  capsule.style.opacity = String(opacity);
  capsule.classList.toggle("rainbow-border", rainbow);
}

export function initAppearance(): void {
  capsule.classList.add("launching");
  window.setTimeout(() => capsule.classList.remove("launching"), 650);
  void invoke<Appearance>("get_settings").then(applyAppearance).catch((error) => {
    console.warn("Failed to load Wisland appearance", error);
  });
  void listen<Appearance>("appearance-changed", (event) => applyAppearance(event.payload));
}
