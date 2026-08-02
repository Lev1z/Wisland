import { capsule } from "../dom";
import { dragStarted, setDragStarted } from "../state";
import { showContextMenu } from "./minimize-drag";
import { switchToNextView } from "./view-switcher";

export function initCapsuleInteraction(): void {
  capsule.addEventListener("click", () => {
    if (dragStarted) setDragStarted(false);
  });

  capsule.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, textarea, #notice-area, .view-dot, .progress-bar, .mp-progress-bar, .mp-volume-bar")) return;
    event.stopPropagation();
    switchToNextView();
  });

  capsule.addEventListener("contextmenu", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("textarea, button")) return;
    event.preventDefault();
    if (capsule.classList.contains("privacy-active")) return;
    showContextMenu();
  });
}
