import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { capsule } from "../dom";
import { isMinimized } from "../state";
import { updateCapsuleSize, updateSwitcherUI } from "./view-switcher";

function applyExpanded(expanded: boolean): void {
  if (expanded) {
    if (isMinimized || capsule.classList.contains("music-expanded")) return;
    capsule.classList.add("expanded");
    capsule.classList.remove("lyric-collapsed");
    updateSwitcherUI();
    return;
  }

  if (capsule.classList.contains("note-active")) return;
  capsule.classList.remove("expanded");
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
