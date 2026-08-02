import { invoke } from "@tauri-apps/api/core";
import { capsule, musicPanelArtist, musicPanelCoverImg, musicPanelSong, vinylCover } from "../dom";
import {
  currentArtistName,
  currentSongTitle,
  currentThumbnailUrl,
  currentView,
  dragStarted,
  isExpandAnimating,
  musicClickTimer,
  setDragStarted,
  setIsExpandAnimating,
  setMusicClickTimer,
  setSkipResizeSync,
} from "../state";
import { fetchAndUpdateVolume } from "./music-controls";
import { showContextMenu } from "./minimize-drag";
import { switchToNextView } from "./view-switcher";

function toggleMusicPanel(): void {
  if (isExpandAnimating) return;
  setIsExpandAnimating(true);
  setSkipResizeSync(true);
  const expanding = !capsule.classList.contains("music-expanded");

  if (expanding) {
    capsule.classList.add("music-expanded");
    musicPanelSong.textContent = currentSongTitle;
    musicPanelArtist.textContent = currentArtistName;
    if (currentThumbnailUrl) {
      vinylCover.style.backgroundImage = `url(${currentThumbnailUrl})`;
      musicPanelCoverImg.style.backgroundImage = `url(${currentThumbnailUrl})`;
    }
    fetchAndUpdateVolume();
    const bodyPadding = Number.parseFloat(getComputedStyle(document.body).paddingTop) || 0;
    void invoke("set_music_expanded", { expanded: true, width: 380, height: 425 + bodyPadding });
  } else {
    capsule.classList.remove("music-expanded");
    void invoke("set_music_expanded", { expanded: false, width: 380, height: 420 });
  }

  window.setTimeout(() => {
    setSkipResizeSync(false);
    setIsExpandAnimating(false);
  }, expanding ? 400 : 500);
}

export function initCapsuleInteraction(): void {
  capsule.addEventListener("click", (event) => {
    if (dragStarted) {
      setDragStarted(false);
      return;
    }
    if (currentView !== "lyric") return;

    const target = event.target as HTMLElement;
    if (target.closest("button, .progress-bar, .mp-progress-bar, .mp-volume-bar")) return;
    if (capsule.classList.contains("music-expanded") && !target.closest("#music-panel-header")) return;

    event.stopPropagation();
    if (musicClickTimer) {
      window.clearTimeout(musicClickTimer);
      setMusicClickTimer(null);
      return;
    }
    setMusicClickTimer(window.setTimeout(() => {
      setMusicClickTimer(null);
      toggleMusicPanel();
    }, 240));
  });

  capsule.addEventListener("dblclick", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, #notice-area, .view-dot, .progress-bar, .mp-progress-bar, .mp-volume-bar")) return;
    if (musicClickTimer) {
      window.clearTimeout(musicClickTimer);
      setMusicClickTimer(null);
    }
    event.stopPropagation();
    switchToNextView();
  });

  capsule.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (capsule.classList.contains("music-expanded") || capsule.classList.contains("privacy-active")) return;
    showContextMenu();
  });
}
