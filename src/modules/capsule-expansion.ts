import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule } from "../dom";
import { isMinimized } from "../state";
import { updateCapsuleSize, updateSwitcherUI } from "./view-switcher";

let motionTimer = 0;

function playMotion(className: "capsule-expanding" | "capsule-collapsing"): void {
  window.clearTimeout(motionTimer);
  capsule.classList.remove("capsule-expanding", "capsule-collapsing");
  void capsule.offsetWidth;
  capsule.classList.add(className);
  motionTimer = window.setTimeout(() => capsule.classList.remove(className), 380);
}

function applyExpanded(expanded: boolean): void {
  const currentlyExpanded = capsule.classList.contains("expanded");
  if (expanded) {
    if (isMinimized || capsule.classList.contains("music-expanded")) return;
    if (currentlyExpanded) return;
    capsule.classList.add("expanded");
    playMotion("capsule-expanding");
    capsule.classList.remove("lyric-collapsed");
    updateSwitcherUI();
    return;
  }

  if (capsule.classList.contains("note-active") || !currentlyExpanded) return;
  capsule.classList.remove("expanded");
  playMotion("capsule-collapsing");
  updateCapsuleSize();
}

export async function initCapsuleExpansion(): Promise<void> {
  await listen<boolean>("set-expand", (event) => applyExpanded(event.payload));
  try {
    applyExpanded(await invoke<boolean>("get_is_expanded"));
  } catch (error) {
    console.warn("Failed to sync capsule expansion state", error);
  }
}
