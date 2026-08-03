import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ViewMode } from "../types";
import { OptionWheelController } from "./option-wheel";
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

const defaultViews: ViewMode[] = ["time", "lyric", "journal", "tray"];
let views: ViewMode[] = [...defaultViews];
const ICONS_PER_PAGE = 3;
const WHEEL_DELTA_THRESHOLD = 1;
const WHEEL_SWITCH_COOLDOWN_MS = 140;
let iconPage = 0;
type ViewSwitcherStyle = "classic" | "option-wheel";
let viewSwitcherStyle: ViewSwitcherStyle = "option-wheel";
let optionWheel: OptionWheelController | null = null;

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

export function setViewOrder(order: string[]): void {
  const normalized: ViewMode[] = [];
  for (const value of [...order, ...defaultViews]) {
    if (defaultViews.includes(value as ViewMode) && !normalized.includes(value as ViewMode)) {
      normalized.push(value as ViewMode);
    }
  }
  views = normalized;
  iconPage = Math.floor(Math.max(0, views.indexOf(currentView)) / ICONS_PER_PAGE);
  updateSwitcherUI(true);
}

function selectViewAt(index: number): void {
  const view = views[index];
  if (!view || view === currentView) return;
  setUserChosenView(view);
  setView(view, true);
}

function getOptionWheel(): OptionWheelController {
  if (!optionWheel) optionWheel = new OptionWheelController(viewDots, selectViewAt);
  return optionWheel;
}

export function setViewSwitcherStyle(style: string): void {
  const normalized: ViewSwitcherStyle = style === "classic" ? "classic" : "option-wheel";
  const changed = normalized !== viewSwitcherStyle;
  viewSwitcherStyle = normalized;
  capsule.classList.toggle("icon-style-option-wheel", normalized === "option-wheel");
  viewSwitcher.dataset.style = normalized;
  getOptionWheel().setEnabled(normalized === "option-wheel");
  updateSwitcherUI(changed);
}

export function updateSwitcherUI(snapWheel = false): void {
  const availableViews = getAvailableViews();
  viewSwitcher.classList.toggle("option-wheel-mode", viewSwitcherStyle === "option-wheel");
  const pageCount = Math.max(1, Math.ceil(availableViews.length / ICONS_PER_PAGE));
  iconPage = Math.min(iconPage, pageCount - 1);
  viewSwitcher.classList.toggle("has-views", availableViews.length > 1);

  if (viewSwitcherStyle === "option-wheel") {
    viewSwitcher.dataset.page = "wheel";
    viewSwitcher.setAttribute("aria-label", "Option Wheel 页面选择器");
    viewDots.replaceChildren();
    const buttons = availableViews.map((view, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `view-dot option-wheel__item page-${view}${view === currentView ? " active" : ""}`;
      button.title = viewMeta[view].title;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("role", "option");
      button.innerHTML = viewMeta[view].icon;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        getOptionWheel().select(index);
      });
      viewDots.appendChild(button);
      return button;
    });
    const wheel = getOptionWheel();
    wheel.setEnabled(true);
    wheel.setItems(buttons, Math.max(0, availableViews.indexOf(currentView)), snapWheel);
    return;
  }

  getOptionWheel().setEnabled(false);
  viewSwitcher.dataset.page = String(iconPage + 1);
  viewSwitcher.setAttribute("aria-label", `切换页面，第 ${iconPage + 1}/${pageCount} 组`);
  viewDots.replaceChildren();

  const pageViews = availableViews.slice(iconPage * ICONS_PER_PAGE, (iconPage + 1) * ICONS_PER_PAGE);
  for (let slot = 0; slot < ICONS_PER_PAGE; slot += 1) {
    const view = pageViews[slot];
    const dot = document.createElement("button");
    dot.type = "button";
    if (!view) {
      dot.className = "view-dot placeholder";
      dot.disabled = true;
      dot.tabIndex = -1;
      dot.setAttribute("aria-hidden", "true");
      viewDots.appendChild(dot);
      continue;
    }
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
  iconPage = Math.floor(Math.max(0, views.indexOf(view)) / ICONS_PER_PAGE);
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
  const waveformBars = Array.from(musicWaveform.querySelectorAll<HTMLElement>("span"));
  let smoothedPeak = 0.12;
  void listen<number>("audio-peak", (event) => {
    const peak = isPlaying ? Math.min(1, Math.sqrt(Math.max(0, event.payload)) * 1.35) : 0.12;
    smoothedPeak += (peak - smoothedPeak) * (peak > smoothedPeak ? 0.7 : 0.28);
    const phase = performance.now() * 0.009;
    waveformBars.forEach((bar, index) => {
      const texture = 0.28 + Math.abs(Math.sin(phase + index * 1.47)) * 0.72;
      const level = isPlaying ? Math.max(0.1, Math.min(1, 0.08 + smoothedPeak * texture)) : 0.14;
      bar.style.setProperty("--wave", level.toFixed(3));
      bar.style.opacity = (0.38 + level * 0.62).toFixed(3);
    });
  });
  viewSwitcher.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.deltaY) < WHEEL_DELTA_THRESHOLD) return;
    const pageCount = Math.ceil(getAvailableViews().length / ICONS_PER_PAGE);
    if (pageCount < 2) return;
    const nextPage = Math.max(0, Math.min(pageCount - 1, iconPage + (event.deltaY > 0 ? 1 : -1)));
    if (nextPage === iconPage) return;
    iconPage = nextPage;
    updateSwitcherUI();
  }, { passive: false });
  let lastWheelAt = 0;
  capsule.addEventListener("wheel", (event) => {
    if (capsule.classList.contains("notice-active") || capsule.classList.contains("privacy-active")) return;
    const target = event.target instanceof Element ? event.target : null;
    const textarea = target?.closest("textarea");
    if (textarea && document.activeElement === textarea) return;
    if (target?.closest("#journal-entry-list")) return;
    const localTray = target?.closest<HTMLElement>("#tray-list");
    if (localTray && localTray.scrollWidth > localTray.clientWidth + 1) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < WHEEL_SWITCH_COOLDOWN_MS || Math.abs(event.deltaY) < WHEEL_DELTA_THRESHOLD) return;
    lastWheelAt = now;
    switchToAdjacentView(event.deltaY > 0 ? 1 : -1);
  }, { passive: false });
}
