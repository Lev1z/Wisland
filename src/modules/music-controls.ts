import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  lyricArea, lyricTextInner, lyricMeta,
  mpLyricText,
  vinylCover,
  musicPanelCoverImg, musicPanelSong, musicPanelArtist,
  progressBar, progressFill, progressThumb,
  mpProgressBar, mpProgressFill, mpProgressThumb,
  mpTimeCurrent, mpTimeTotal,
  mpPrev, mpPlay, mpNext,
  mpVolumeBar, mpVolumeFill, mpVolumeThumb,
  btnPrev, btnPlay, btnNext,
} from "../dom";
import {
  setIsMusicPlaying,
  setIsPlaying,
  setCurrentSongTitle, setCurrentArtistName,
  setCurrentThumbnailUrl,
  currentDurationMs, setCurrentDurationMs,
  isSeeking, setIsSeeking,
  isMpSeeking, setIsMpSeeking,
  isMpVolSeeking, setIsMpVolSeeking,
  isSeekable, setIsSeekable,
  volThrottleTimer, setVolThrottleTimer,
} from "../state";
import { formatTime } from "../utils";
import { updatePlayIcon, updateSwitcherUI } from "./view-switcher";
import { resetMpLyricFlipState } from "./lyric-renderer";

function applyAlbumAccent(source: string): void {
  if (!source) {
    lyricArea.style.removeProperty("--music-accent");
    return;
  }
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 12;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0, 12, 12);
    const pixels = context.getImageData(0, 0, 12, 12).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 96) continue;
      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const range = Math.max(r, g, b) - Math.min(r, g, b);
      const brightness = (r + g + b) / 3;
      const sampleWeight = 1 + range / 72;
      if (brightness < 22 || brightness > 242) continue;
      red += r * sampleWeight;
      green += g * sampleWeight;
      blue += b * sampleWeight;
      weight += sampleWeight;
    }
    if (weight === 0) return;
    const lift = (value: number) => Math.round(Math.max(74, Math.min(235, value / weight)));
    lyricArea.style.setProperty("--music-accent", `rgb(${lift(red)}, ${lift(green)}, ${lift(blue)})`);
  };
  image.src = source;
}

// ===== 面板音量滑块 =====

// 展开面板时获取当前音量
export function fetchAndUpdateVolume() {
  invoke<number>("media_get_volume").then((vol) => {
    const pct = Math.min(100, Math.max(0, vol * 100));
    mpVolumeFill.style.width = `${pct}%`;
    mpVolumeThumb.style.left = `${pct}%`;
  }).catch(() => {});
}

function updateMpVolumeFromMouse(e: MouseEvent) {
  const rect = mpVolumeBar.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  mpVolumeFill.style.width = `${pct * 100}%`;
  mpVolumeThumb.style.left = `${pct * 100}%`;
  return pct;
}

// ===== 进度条拖动（Seek）=====

export function updateSeekable(seekable: boolean) {
  if (isSeekable === seekable) return;
  setIsSeekable(seekable);
  progressBar.classList.toggle("no-seek", !seekable);
  mpProgressBar.classList.toggle("no-seek", !seekable);
}

function updateProgressFromMouse(e: MouseEvent) {
  const rect = progressBar.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  progressFill.style.width = `${pct * 100}%`;
  progressThumb.style.left = `${pct * 100}%`;
  return pct;
}

function updateMpProgressFromMouse(e: MouseEvent) {
  const rect = mpProgressBar.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  mpProgressFill.style.width = `${pct * 100}%`;
  mpProgressThumb.style.left = `${pct * 100}%`;
  mpTimeCurrent.textContent = formatTime(pct * currentDurationMs);
  return pct;
}

export function initMusicControls() {

  // ===== Tauri 事件监听 =====

  listen<boolean>("playback-state", (event) => {
    setIsPlaying(event.payload);
    updatePlayIcon();
  });

  listen<{ title: string; artist: string; genre?: string; thumbnail?: string | null; duration_ms?: number; seekable?: boolean }>("media-changed", (event) => {
    setIsMusicPlaying(true);
    setCurrentSongTitle(event.payload.title);
    setCurrentArtistName(event.payload.artist);
    console.log(`[SMTC] genre='${event.payload.genre ?? ""}' title='${event.payload.title}' artist='${event.payload.artist}'`);
    lyricTextInner.textContent = "♪";
    lyricMeta.textContent = `${event.payload.artist} - ${event.payload.title}`;
    mpLyricText.textContent = "♪";
    resetMpLyricFlipState();
    lyricMeta.style.fontSize = "";
    lyricMeta.style.color = "";

    // 同步面板信息
    musicPanelSong.textContent = event.payload.title;
    musicPanelArtist.textContent = event.payload.artist;

    // 更新封面
    if (event.payload.thumbnail) {
      setCurrentThumbnailUrl(event.payload.thumbnail);
      vinylCover.style.backgroundImage = `url(${event.payload.thumbnail})`;
      musicPanelCoverImg.style.backgroundImage = `url(${event.payload.thumbnail})`;
      applyAlbumAccent(event.payload.thumbnail);
    } else {
      setCurrentThumbnailUrl("");
      vinylCover.style.backgroundImage = "";
      musicPanelCoverImg.style.backgroundImage = "";
      applyAlbumAccent("");
    }

    // 更新时长
    if (event.payload.duration_ms) {
      setCurrentDurationMs(event.payload.duration_ms);
      mpTimeTotal.textContent = formatTime(event.payload.duration_ms);
    } else {
      setCurrentDurationMs(0);
      mpTimeTotal.textContent = "0:00";
    }

    // 更新 seekable 状态
    updateSeekable(event.payload.seekable ?? true);

    // 重置进度条
    progressFill.style.width = "0%";
    progressThumb.style.left = "0%";
    mpProgressFill.style.width = "0%";
    mpProgressThumb.style.left = "0%";
    mpTimeCurrent.textContent = "0:00";

    updateSwitcherUI();
  });

  listen<{ title: string; artist: string }>("media-paused", () => {
    setIsMusicPlaying(true);
  });

  // 异步封面加载完成
  listen<{ thumbnail: string }>("media-thumbnail", (event) => {
    if (event.payload.thumbnail) {
      setCurrentThumbnailUrl(event.payload.thumbnail);
      vinylCover.style.backgroundImage = `url(${event.payload.thumbnail})`;
      musicPanelCoverImg.style.backgroundImage = `url(${event.payload.thumbnail})`;
      applyAlbumAccent(event.payload.thumbnail);
    }
  });

  // ===== 收起态播放控制 =====

  btnPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_prev");
  });

  btnPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_play_pause");
  });

  btnNext.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_next");
  });

  // ===== 面板播放控制 =====

  mpPrev.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_prev");
  });

  mpPlay.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_play_pause");
  });

  mpNext.addEventListener("click", (e) => {
    e.stopPropagation();
    void invoke("media_next");
  });

  // ===== 面板音量滑块事件 =====

  mpVolumeBar.addEventListener("mousedown", (e: MouseEvent) => {
    e.stopPropagation();
    setIsMpVolSeeking(true);
    mpVolumeBar.classList.add("seeking");
    const pct = updateMpVolumeFromMouse(e);
    void invoke("media_set_volume", { volume: pct }).catch(() => {});
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isMpVolSeeking) return;
    const pct = updateMpVolumeFromMouse(e);
    // 节流：拖动时每50ms更新一次音量
    if (!volThrottleTimer) {
      setVolThrottleTimer(window.setTimeout(() => {
        setVolThrottleTimer(null);
      }, 50));
      void invoke("media_set_volume", { volume: pct }).catch(() => {});
    }
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!isMpVolSeeking) return;
    setIsMpVolSeeking(false);
    mpVolumeBar.classList.remove("seeking");
    const pct = updateMpVolumeFromMouse(e);
    void invoke("media_set_volume", { volume: pct }).catch((err: unknown) => {
      console.warn("Set volume failed:", err);
    });
  });

  // ===== 进度条拖动（收起态） =====

  progressBar.addEventListener("mousedown", (e: MouseEvent) => {
    if (currentDurationMs <= 0 || !isSeekable) return;
    e.stopPropagation();
    setIsSeeking(true);
    progressBar.classList.add("seeking");
    updateProgressFromMouse(e);
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isSeeking) return;
    updateProgressFromMouse(e);
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!isSeeking) return;
    setIsSeeking(false);
    progressBar.classList.remove("seeking");
    const pct = updateProgressFromMouse(e);
    const seekMs = Math.round(pct * currentDurationMs);
    void invoke("media_seek", { positionMs: seekMs }).catch((err: unknown) => {
      console.warn("Seek failed:", err);
    });
  });

  // ===== 面板进度条拖动（Seek）=====

  mpProgressBar.addEventListener("mousedown", (e: MouseEvent) => {
    if (currentDurationMs <= 0 || !isSeekable) return;
    e.stopPropagation();
    setIsMpSeeking(true);
    mpProgressBar.classList.add("seeking");
    updateMpProgressFromMouse(e);
  });

  document.addEventListener("mousemove", (e: MouseEvent) => {
    if (!isMpSeeking) return;
    updateMpProgressFromMouse(e);
  });

  document.addEventListener("mouseup", (e: MouseEvent) => {
    if (!isMpSeeking) return;
    setIsMpSeeking(false);
    mpProgressBar.classList.remove("seeking");
    const pct = updateMpProgressFromMouse(e);
    const seekMs = Math.round(pct * currentDurationMs);
    void invoke("media_seek", { positionMs: seekMs }).catch((err: unknown) => {
      console.warn("Seek failed:", err);
    });
  });

}
