import { invoke } from "@tauri-apps/api/core";
import type { ViewMode } from "../types";
import {
  capsule,
  currentViewContainer,
  iconPause,
  iconPlay,
  mpIconPause,
  mpIconPlay,
  viewDots,
  viewElements,
  viewHolder,
  viewSwitcher,
  vinylDisc,
} from "../dom";
import {
  currentView,
  isMusicPlaying,
  isPlaying,
  lyricMode,
  setCurrentView,
  setIsExpandAnimating,
  setSkipResizeSync,
  setUserChosenView,
} from "../state";

export function getAvailableViews(): ViewMode[] {
  const views: ViewMode[] = ["time"];
  if (isMusicPlaying && lyricMode !== "off") views.push("lyric");
  return views;
}

export function updateSwitcherUI(): void {
  const views = getAvailableViews();
  viewSwitcher.classList.toggle("has-views", views.length > 1);
  viewDots.replaceChildren();

  for (const view of views) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `view-dot${view === currentView ? " active" : ""}`;
    dot.title = view === "time" ? "时间" : "音乐";
    dot.setAttribute("aria-label", dot.title);
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      setUserChosenView(view);
      setView(view, true);
    });
    viewDots.appendChild(dot);
  }
}

function mountView(view: ViewMode): void {
  while (currentViewContainer.firstChild) {
    viewHolder.appendChild(currentViewContainer.firstChild);
  }
  const element = viewElements[view];
  currentViewContainer.appendChild(element);
  element.style.display = "flex";
}

export function showOnlyView(view: ViewMode): void {
  for (const element of Object.values(viewElements)) {
    element.getAnimations().forEach((animation) => animation.cancel());
    element.style.opacity = "";
    element.style.transform = "";
  }
  mountView(view);
}

function animateViewSwitch(from: ViewMode, to: ViewMode): void {
  if (from === to) {
    showOnlyView(to);
    return;
  }

  const previous = viewElements[from];
  const next = viewElements[to];
  if (previous.parentElement === currentViewContainer) {
    const animation = previous.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-8px) scale(.985)" },
      ],
      { duration: 150, easing: "ease-in", fill: "forwards" },
    );
    animation.onfinish = () => viewHolder.appendChild(previous);
  }

  currentViewContainer.appendChild(next);
  next.style.display = "flex";
  next.animate(
    [
      { opacity: 0, transform: "translateY(8px) scale(.985)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
}

export function updateCapsuleSize(): void {
  if (capsule.classList.contains("expanded")) {
    capsule.classList.remove("lyric-collapsed", "music-expanded");
    return;
  }
  capsule.classList.toggle("lyric-collapsed", currentView === "lyric" && isMusicPlaying);
}

export function setView(view: ViewMode, animated = true): void {
  const previous = currentView;
  setCurrentView(view);

  if (previous === "lyric" && view !== "lyric" && capsule.classList.contains("music-expanded")) {
    setSkipResizeSync(true);
    setIsExpandAnimating(false);
    capsule.classList.remove("music-expanded");
    void invoke("set_music_expanded", { expanded: false, width: 380, height: 420 });
    window.setTimeout(() => setSkipResizeSync(false), 500);
  }

  animated ? animateViewSwitch(previous, view) : showOnlyView(view);
  updateCapsuleSize();
  updateSwitcherUI();
  void syncCurrentView(view);
}

export function switchToNextView(): void {
  const views = getAvailableViews();
  if (views.length < 2) return;
  const currentIndex = views.indexOf(currentView);
  const next = views[(currentIndex + 1) % views.length];
  setUserChosenView(next);
  setView(next, true);
}

export function syncCurrentView(view: ViewMode): Promise<unknown> {
  return invoke("set_current_view", { view }).catch((error) => {
    console.warn("Failed to sync current view", error);
  });
}

export function updatePlayIcon(): void {
  iconPlay.style.display = isPlaying ? "none" : "block";
  iconPause.style.display = isPlaying ? "block" : "none";
  mpIconPlay.style.display = isPlaying ? "none" : "block";
  mpIconPause.style.display = isPlaying ? "block" : "none";
  vinylDisc.classList.toggle("paused", !isPlaying);
}

export function initViewSwitcher(): void {
  updateSwitcherUI();
}
