import type { ViewMode } from "./types";

function required<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element: #${id}`);
  return element as unknown as T;
}

export const capsule = required<HTMLDivElement>("island-capsule");
export const currentViewContainer = required<HTMLDivElement>("current-view");
export const environmentCheckArea = required<HTMLElement>("environment-check-area");
export const environmentCheckFull = required<HTMLDivElement>("environment-check-full");
export const environmentCheckList = required<HTMLDivElement>("environment-check-list");
export const environmentCheckCompact = required<HTMLDivElement>("environment-check-compact");
export const environmentCompactIcon = required<HTMLSpanElement>("environment-compact-icon");
export const environmentCompactText = required<HTMLSpanElement>("environment-compact-text");
export const environmentRefresh = required<HTMLButtonElement>("environment-refresh");
export const environmentSkip = required<HTMLButtonElement>("environment-skip");
export const viewHolder = required<HTMLDivElement>("view-holder");
export const timeWrapper = required<HTMLDivElement>("time-wrapper");
export const timeText = required<HTMLDivElement>("time-text");
export const homeDate = required<HTMLDivElement>("home-date");
export const codexQuotaRing = required<HTMLDivElement>("codex-quota-ring");
export const codexQuotaProgress = required<SVGCircleElement>("codex-quota-progress");
export const codexLeftCustomVisual = required<HTMLImageElement>("codex-left-custom-visual");
export const codexQuotaLabel = required<HTMLDivElement>("codex-quota-label");
export const codexStatusDot = required<HTMLDivElement>("codex-status-dot");
export const codexRightCustomVisual = required<HTMLImageElement>("codex-right-custom-visual");
export const codexStatusLabel = required<HTMLDivElement>("codex-status-label");
export const noticeArea = required<HTMLDivElement>("notice-area");
export const fileDropOverlay = required<HTMLDivElement>("file-drop-overlay");
export const lyricArea = required<HTMLDivElement>("lyric-area");
export const musicWaveform = required<HTMLDivElement>("music-waveform");
export const lyricText = required<HTMLDivElement>("lyric-text");
export const lyricTextInner = required<HTMLSpanElement>("lyric-text-inner");
export const lyricMeta = required<HTMLDivElement>("lyric-meta");
export const vinylDisc = required<HTMLDivElement>("vinyl-disc");
export const vinylCover = required<HTMLDivElement>("vinyl-cover");
export const progressBar = required<HTMLDivElement>("progress-bar");
export const progressFill = required<HTMLDivElement>("progress-fill");
export const progressThumb = required<HTMLDivElement>("progress-thumb");
export const musicPanelCoverImg = required<HTMLDivElement>("music-panel-cover-img");
export const musicPanelSong = required<HTMLDivElement>("music-panel-song");
export const musicPanelArtist = required<HTMLDivElement>("music-panel-artist");
export const mpProgressBar = required<HTMLDivElement>("mp-progress-bar");
export const mpProgressFill = required<HTMLDivElement>("mp-progress-fill");
export const mpProgressThumb = required<HTMLDivElement>("mp-progress-thumb");
export const mpTimeCurrent = required<HTMLSpanElement>("mp-time-current");
export const mpTimeTotal = required<HTMLSpanElement>("mp-time-total");
export const mpPrev = required<HTMLButtonElement>("mp-prev");
export const mpPlay = required<HTMLButtonElement>("mp-play");
export const mpNext = required<HTMLButtonElement>("mp-next");
export const mpIconPlay = mpPlay.querySelector(".mp-icon-play") as SVGElement;
export const mpIconPause = mpPlay.querySelector(".mp-icon-pause") as SVGElement;
export const mpVolumeBar = required<HTMLDivElement>("mp-volume-bar");
export const mpVolumeFill = required<HTMLDivElement>("mp-volume-fill");
export const mpVolumeThumb = required<HTMLDivElement>("mp-volume-thumb");
export const mpLyricText = required<HTMLDivElement>("mp-lyric-text");
export const btnPrev = required<HTMLButtonElement>("btn-prev");
export const btnPlay = required<HTMLButtonElement>("btn-play");
export const btnNext = required<HTMLButtonElement>("btn-next");
export const iconPlay = required<HTMLElement>("icon-play");
export const iconPause = required<HTMLElement>("icon-pause");
export const viewSwitcher = required<HTMLDivElement>("view-switcher");
export const viewDots = required<HTMLDivElement>("view-dots");
export const privacyIndicators = required<HTMLDivElement>("privacy-indicators");
export const privacyMic = required<HTMLDivElement>("privacy-mic");
export const privacyCamera = required<HTMLDivElement>("privacy-camera");
export const collapsedIndicator = required<HTMLDivElement>("collapsed-indicator");
export const journalArea = required<HTMLDivElement>("journal-area");
export const journalSummary = required<HTMLDivElement>("journal-summary");
export const journalComposer = required<HTMLFormElement>("journal-composer");
export const journalKindNote = required<HTMLButtonElement>("journal-kind-note");
export const journalKindTodo = required<HTMLButtonElement>("journal-kind-todo");
export const journalKindBrowse = required<HTMLButtonElement>("journal-kind-browse");
export const journalInput = required<HTMLTextAreaElement>("journal-input");
export const journalBrowser = required<HTMLDivElement>("journal-browser");
export const journalBrowserNotes = required<HTMLButtonElement>("journal-browser-notes");
export const journalBrowserTodos = required<HTMLButtonElement>("journal-browser-todos");
export const journalEntryList = required<HTMLDivElement>("journal-entry-list");
export const journalSave = required<HTMLButtonElement>("journal-save");
export const journalCancel = required<HTMLButtonElement>("journal-cancel");
export const trayArea = required<HTMLDivElement>("tray-area");
export const traySummary = required<HTMLDivElement>("tray-summary");
export const trayCount = required<HTMLElement>("tray-count");
export const trayList = required<HTMLDivElement>("tray-list");
export const trayEmpty = required<HTMLDivElement>("tray-empty");
export const trayContextMenu = required<HTMLDivElement>("tray-context-menu");
export const trayCopy = required<HTMLButtonElement>("tray-copy");
export const trayRemove = required<HTMLButtonElement>("tray-remove");

export const viewElements: Record<ViewMode, HTMLElement> = {
  time: timeWrapper,
  lyric: lyricArea,
  journal: journalArea,
  tray: trayArea,
};
