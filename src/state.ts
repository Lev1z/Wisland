import type { ViewMode, PrivacyUsagePayload } from "./types";

// --- 音乐 / 播放 ---

export let isMusicPlaying = false;
export function setIsMusicPlaying(v: boolean) { isMusicPlaying = v; }

export let isPlaying = false;
export function setIsPlaying(v: boolean) { isPlaying = v; }

export let lyricMode = "off"; // "off" | "info" | "lyric"
export function setLyricMode(v: string) { lyricMode = v; }

export let currentDurationMs = 0; // 歌曲总时长
export function setCurrentDurationMs(v: number) { currentDurationMs = v; }

export let isSeeking = false; // 是否正在拖动进度条
export function setIsSeeking(v: boolean) { isSeeking = v; }

export let isMpSeeking = false; // 面板进度条拖动
export function setIsMpSeeking(v: boolean) { isMpSeeking = v; }

export let isMpVolSeeking = false; // 面板音量条拖动
export function setIsMpVolSeeking(v: boolean) { isMpVolSeeking = v; }

export let isSeekable = true; // 当前播放器是否支持 seek
export function setIsSeekable(v: boolean) { isSeekable = v; }

export let musicClickTimer: number | null = null; // 音乐单击延时
export function setMusicClickTimer(v: number | null) { musicClickTimer = v; }

export let currentSongTitle = "";
export function setCurrentSongTitle(v: string) { currentSongTitle = v; }

export let currentArtistName = "";
export function setCurrentArtistName(v: string) { currentArtistName = v; }

export let currentThumbnailUrl = "";
export function setCurrentThumbnailUrl(v: string) { currentThumbnailUrl = v; }

// --- 隐私 ---

export let privacyPopupTimer: number | null = null;
export function setPrivacyPopupTimer(v: number | null) { privacyPopupTimer = v; }

export let privacyPulseCleanupTimer: number | null = null;
export function setPrivacyPulseCleanupTimer(v: number | null) { privacyPulseCleanupTimer = v; }

export let lastPrivacyUsage: PrivacyUsagePayload = {

  microphone: false,

  camera: false,

};
export function setLastPrivacyUsage(v: PrivacyUsagePayload) { lastPrivacyUsage = v; }

// --- 最小化 / 展开动画 ---

export let isMinimized = false;
export function setIsMinimized(v: boolean) { isMinimized = v; }

export let isExpandAnimating = false; // 展开/收起动画进行中，防止重复触发
export function setIsExpandAnimating(v: boolean) { isExpandAnimating = v; }

export let isMinimizeAnimating = false; // 最小化/恢复动画进行中
export function setIsMinimizeAnimating(v: boolean) { isMinimizeAnimating = v; }

// --- 展开态多行歌词的 FLIP 过渡状态：key（文本+重复序号）→ 行 DOM ---

export let prevLineMap: Map<string, HTMLElement> = new Map();
export function setPrevLineMap(v: Map<string, HTMLElement>) { prevLineMap = v; }

// --- 视图 ---

export let currentView: ViewMode = "time";
export function setCurrentView(v: ViewMode) { currentView = v; }

export let userChosenView: ViewMode = "time";
export function setUserChosenView(v: ViewMode) { userChosenView = v; }

// --- 歌词 token / 动画相关 ---

// Cache for token spans to optimize animation performance
export let tokenSpans: HTMLSpanElement[] = [];
export function setTokenSpans(v: HTMLSpanElement[]) { tokenSpans = v; }

export let currentLyricTokenKey = "";
export function setCurrentLyricTokenKey(v: string) { currentLyricTokenKey = v; }

export let activeLyricTokens: Array<{text: string; start_ms: number; end_ms: number}> | null = null;
export function setActiveLyricTokens(v: Array<{text: string; start_ms: number; end_ms: number}> | null) { activeLyricTokens = v; }

export let activeLyricBasePositionMs = 0;
export function setActiveLyricBasePositionMs(v: number) { activeLyricBasePositionMs = v; }

export let activeLyricBasePerfMs = 0;
export function setActiveLyricBasePerfMs(v: number) { activeLyricBasePerfMs = v; }

export let lyricScrollLineStartMs: number | null = null;
export function setLyricScrollLineStartMs(v: number | null) { lyricScrollLineStartMs = v; }

export let lyricScrollNextLineTimeMs: number | null = null;
export function setLyricScrollNextLineTimeMs(v: number | null) { lyricScrollNextLineTimeMs = v; }

export let lyricScrollLastX = 0;
export function setLyricScrollLastX(v: number) { lyricScrollLastX = v; }

export let mpCurrentLyricInner: HTMLSpanElement | null = null;
export function setMpCurrentLyricInner(v: HTMLSpanElement | null) { mpCurrentLyricInner = v; }

export let mpCurrentLyricOuter: HTMLElement | null = null;
export function setMpCurrentLyricOuter(v: HTMLElement | null) { mpCurrentLyricOuter = v; }

export let mpTokenSpans: HTMLSpanElement[] = [];
export function setMpTokenSpans(v: HTMLSpanElement[]) { mpTokenSpans = v; }

export let currentMpLyricTokenKey = '';
export function setCurrentMpLyricTokenKey(v: string) { currentMpLyricTokenKey = v; }

export let lyricFpsWindowStartMs = 0;
export function setLyricFpsWindowStartMs(v: number) { lyricFpsWindowStartMs = v; }

export let lyricFpsFrameCount = 0;
export function setLyricFpsFrameCount(v: number) { lyricFpsFrameCount = v; }

// Animation frame ID for token highlighting
export let tokenAnimationId: number | null = null;
export function setTokenAnimationId(v: number | null) { tokenAnimationId = v; }

// --- 拖拽状态 ---

export let isDragging = false;
export function setIsDragging(v: boolean) { isDragging = v; }

export let dragStarted = false;
export function setDragStarted(v: boolean) { dragStarted = v; }

export let lastX = 0;
export function setLastX(v: number) { lastX = v; }

export let lastY = 0;
export function setLastY(v: number) { lastY = v; }

export let mouseDownX = 0;
export function setMouseDownX(v: number) { mouseDownX = v; }

export let mouseDownY = 0;
export function setMouseDownY(v: number) { mouseDownY = v; }

export const DRAG_THRESHOLD = 5; // 像素，超过此距离才算拖动

// --- 其他散落状态 ---

export let skipResizeSync = false;
export function setSkipResizeSync(v: boolean) { skipResizeSync = v; }

export let volThrottleTimer: number | null = null;
export function setVolThrottleTimer(v: number | null) { volThrottleTimer = v; }
