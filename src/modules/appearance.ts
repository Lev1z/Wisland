import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule, codexLeftCustomVisual, codexRightCustomVisual } from "../dom";
import { setViewOrder, setViewSwitcherStyle } from "./view-switcher";

type CustomAsset = { id: string; name: string; data_url?: string; dataUrl?: string };

type Appearance = {
  capsule_opacity?: number;
  capsule_scale?: number;
  rainbow_border?: boolean;
  icon_bar_style?: string;
  icon_bar_order?: string[];
  border_effect?: string;
  border_custom_source?: string;
  left_visual_mode?: string;
  left_visual_source?: string;
  right_visual_mode?: string;
  right_visual_source?: string;
  visual_assets?: CustomAsset[];
  border_assets?: CustomAsset[];
  opacity?: number;
  scale?: number;
  rainbowBorder?: boolean;
  iconBarStyle?: string;
  iconBarOrder?: string[];
  borderEffect?: string;
  borderCustomSource?: string;
  leftVisualMode?: string;
  leftVisualSource?: string;
  rightVisualMode?: string;
  rightVisualSource?: string;
  visualAssets?: CustomAsset[];
  borderAssets?: CustomAsset[];
};

function resolveVisualSource(source: string | undefined, assets: CustomAsset[]): string {
  if (!source) return "";
  if (source.startsWith("data:image/")) return source;
  if (source === "builtin:cat-wave") return "/assets/visuals/cat-wave.gif";
  if (source === "builtin:dog-wave") return "/assets/visuals/dog-wave.gif";
  const id = source.startsWith("asset:") ? source.slice(6) : "";
  const asset = assets.find((item) => item.id === id);
  return asset?.dataUrl ?? asset?.data_url ?? "";
}

const dimensions = {
  "--collapsed-w": 140,
  "--collapsed-h": 50,
  "--lyric-collapsed-w": 190,
  "--journal-collapsed-w": 250,
  "--tray-collapsed-w": 190,
  "--expanded-w": 330,
  "--expanded-h": 74,
  "--left-slot-size": 20,
  "--right-slot-size": 20,
  "--custom-slot-size": 28,
  "--clock-slot-size": 20,
  "--status-dot-size": 12,
} as const;

const scalePresets = [0.8, 1, 1.25, 1.5] as const;

function nearestScale(value: number): number {
  return scalePresets.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  1);
}

function applyAppearance(settings: Appearance): void {
  const opacity = Math.max(0.6, Math.min(1, settings.opacity ?? settings.capsule_opacity ?? 1));
  const scale = nearestScale(settings.scale ?? settings.capsule_scale ?? 1);
  const legacyRainbow = settings.rainbowBorder ?? settings.rainbow_border ?? false;
  const borderEffect = settings.borderEffect ?? settings.border_effect ?? (legacyRainbow ? "aurora" : "off");
  const visualAssets = settings.visualAssets ?? settings.visual_assets ?? [];
  const borderAssets = settings.borderAssets ?? settings.border_assets ?? [];
  for (const [property, value] of Object.entries(dimensions)) {
    document.documentElement.style.setProperty(property, `${value * scale}px`);
  }
  document.documentElement.style.fontSize = `${10 * scale}px`;
  capsule.style.opacity = String(opacity);
  capsule.classList.remove(
    "rainbow-border",
    "border-effect-klein",
    "border-effect-aurora",
    "border-effect-mono",
    "border-effect-custom",
  );
  if (["klein", "aurora", "mono", "custom"].includes(borderEffect)) {
    capsule.classList.add(`border-effect-${borderEffect}`);
  }
  const borderSource = resolveVisualSource(settings.borderCustomSource ?? settings.border_custom_source, borderAssets);
  if (borderEffect === "custom" && borderSource) {
    capsule.style.setProperty("--custom-border-image", `url(${JSON.stringify(borderSource)})`);
  } else {
    capsule.style.removeProperty("--custom-border-image");
  }

  const leftSource = resolveVisualSource(settings.leftVisualSource ?? settings.left_visual_source, visualAssets);
  const leftCustom = (settings.leftVisualMode ?? settings.left_visual_mode) === "custom" && !!leftSource;
  codexLeftCustomVisual.src = leftCustom ? leftSource : "";
  codexLeftCustomVisual.hidden = !leftCustom;
  capsule.classList.toggle("left-slot-custom", leftCustom);

  const rightSource = resolveVisualSource(settings.rightVisualSource ?? settings.right_visual_source, visualAssets);
  const rightCustom = (settings.rightVisualMode ?? settings.right_visual_mode) === "custom" && !!rightSource;
  codexRightCustomVisual.src = rightCustom ? rightSource : "";
  codexRightCustomVisual.hidden = !rightCustom;
  capsule.classList.toggle("right-slot-custom", rightCustom);

  setViewOrder(settings.iconBarOrder ?? settings.icon_bar_order ?? []);
  setViewSwitcherStyle(settings.iconBarStyle ?? settings.icon_bar_style ?? "option-wheel");
}

export function initAppearance(): void {
  capsule.classList.add("launching");
  window.setTimeout(() => capsule.classList.remove("launching"), 650);
  void invoke<Appearance>("get_settings").then(applyAppearance).catch((error) => {
    console.warn("Failed to load Wisland appearance", error);
  });
  void listen<Appearance>("appearance-changed", (event) => applyAppearance(event.payload));
}
