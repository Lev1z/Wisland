import { invoke } from "@tauri-apps/api/core";
import type { ViewMode } from "../types";
import {
  capsule,
  currentViewContainer,
  iconPause,
  iconPlay,
  mpIconPause,
  mpIconPlay,
  musicWaveform,
  viewDots,
  viewElements,
  viewHolder,
  viewSwitcher,
  vinylDisc,
} from "../dom";
import {
  currentView,
  isPlaying,
  setCurrentView,
  setIsExpandAnimating,
  setSkipResizeSync,
  setUserChosenView,
} from "../state";

const views: ViewMode[] = ["time", "lyric", "journal", "tray"];

const viewMeta: Record<ViewMode, { title: string; icon: string }> = {
  time: {
    title: "主页",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.2 12 4l8 7.2v8.3a.5.5 0 0 1-.5.5h-5v-6h-5v6h-5a.5.5 0 0 1-.5-.5z"/></svg>',
  },
  lyric: {
    title: "音乐",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v10.3a3.5 3.5 0 1 1-2-3.15V7l11-2v8.3a3.5 3.5 0 1 1-2-3.15V3z"/></svg>',
  },
  journal: {
    title: "日记",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 6.7 4.2L17 18.5 12 22l-5-3.5L5.3 7.2zm0 4.1L9.2 12l2.8 5 2.8-5z"/></svg>',
  },
  tray: {
    title: "临时托盘",
    icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14l2 7v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6zm0 8v5h14v-5h-4l-1 2h-4l-1-2z"/></svg>',
  },
};

export function getAvailableViews(): ViewMode[] {
  return views;
}

export function updateSwitcherUI(): void {
  const views = getAvailableViews();
  viewSwitcher.classList.toggle("has-views", views.length > 1);
  viewDots.replaceChildren();

  for (const view of views) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `view-dot page-${view}${view === currentView ? " active" : ""}`;
    dot.title = viewMeta[view].title;
    dot.setAttribute("aria-label", dot.title);
    dot.innerHTML = viewMeta[view].icon;
    dot.addEventListener("click", (event) => {
      event.stopPropagation();
      setUserChosenView(view);
      setView(view, true);
    });
    viewDots.appendChild(dot);
  }
}

function applyViewClass(view: ViewMode): void {
  capsule.classList.remove("view-time", "view-lyric", "view-journal", "view-tray");
  capsule.classList.add(`view-${view}`);
}

function mountView(view: ViewMode): void {
  while (currentViewContainer.firstChild) {
    viewHolder.appendChild(currentViewContainer.firstChild);
  }
  const element = viewElements[view];
  currentViewContainer.appendChild(element);
  element.style.display = "flex";
  applyViewClass(view);
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
  previous.getAnimations().forEach((animation) => animation.cancel());
  next.getAnimations().forEach((animation) => animation.cancel());
  previous.style.opacity = "";
  previous.style.transform = "";
  next.style.opacity = "";
  next.style.transform = "";
  if (previous.parentElement === currentViewContainer) {
    const animation = previous.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-8px) scale(.985)" },
      ],
      { duration: 150, easing: "ease-in", fill: "forwards" },
    );
    animation.onfinish = () => {
      animation.cancel();
      viewHolder.appendChild(previous);
    };
  }

  currentViewContainer.appendChild(next);
  next.style.display = "flex";
  const incoming = next.animate(
    [
      { opacity: 0, transform: "translateY(8px) scale(.985)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  incoming.onfinish = () => incoming.cancel();
}

export function updateCapsuleSize(): void {
  if (capsule.classList.contains("expanded")) {
    capsule.classList.remove("lyric-collapsed", "music-expanded");
    return;
  }
  capsule.classList.toggle("lyric-collapsed", currentView === "lyric");
}

export function setView(view: ViewMode, animated = true): void {
  const previous = currentView;
  setCurrentView(view);
  applyViewClass(view);

  if (previous === "journal" && view !== "journal") {
    void invoke("set_interacting", { active: false });
  }

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
  switchToAdjacentView(1);
}

export function switchToAdjacentView(direction: 1 | -1): void {
  const views = getAvailableViews();
  if (views.length < 2) return;
  const currentIndex = views.indexOf(currentView);
  const next = views[(currentIndex + direction + views.length) % views.length];
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
  musicWaveform.classList.toggle("paused", !isPlaying);
}

export function initViewSwitcher(): void {
  updateSwitcherUI();
  let lastWheelAt = 0;
  capsule.addEventListener("wheel", (event) => {
    if (capsule.classList.contains("notice-active") || capsule.classList.contains("privacy-active")) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < 220 || Math.abs(event.deltaY) < 4) return;
    lastWheelAt = now;
    switchToAdjacentView(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}
