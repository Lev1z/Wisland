import { listen } from "@tauri-apps/api/event";
import {
  lyricText, lyricTextInner, lyricMeta,
  mpLyricText,
  progressFill, progressThumb,
  mpProgressFill, mpProgressThumb,
  mpTimeCurrent, mpTimeTotal,
} from "../dom";
import {
  setIsMusicPlaying,
  isPlaying, setIsPlaying,
  lyricMode, setLyricMode,
  setCurrentDurationMs,
  isSeeking,
  isMpSeeking,
  tokenSpans, setTokenSpans,
  currentLyricTokenKey, setCurrentLyricTokenKey,
  activeLyricTokens, setActiveLyricTokens,
  activeLyricBasePositionMs, setActiveLyricBasePositionMs,
  activeLyricBasePerfMs, setActiveLyricBasePerfMs,
  lyricScrollLineStartMs, setLyricScrollLineStartMs,
  lyricScrollNextLineTimeMs, setLyricScrollNextLineTimeMs,
  lyricScrollLastX, setLyricScrollLastX,
  mpCurrentLyricInner, setMpCurrentLyricInner,
  mpCurrentLyricOuter, setMpCurrentLyricOuter,
  mpTokenSpans, setMpTokenSpans,
  currentMpLyricTokenKey, setCurrentMpLyricTokenKey,
  lyricFpsWindowStartMs, setLyricFpsWindowStartMs,
  lyricFpsFrameCount, setLyricFpsFrameCount,
  tokenAnimationId, setTokenAnimationId,
  prevLineMap, setPrevLineMap,
} from "../state";
import { formatTime } from "../utils";
import { updateSwitcherUI, updatePlayIcon } from "./view-switcher";
import { updateSeekable } from "./music-controls";

/**
 * 生成 token 列表的稳定标识，用于判断 DOM 是否需要重建。
 * @param tokens token 序列（含文本与起止时间戳）。
 * @returns 可用于等值比较的 key 字符串。
 */
function buildTokensKey(tokens: Array<{ text: string; start_ms: number; end_ms: number }>): string {
  return tokens.map((t) => `${t.text}\u0001${t.start_ms}\u0001${t.end_ms}`).join('\u0002');
}

/**
 * 根据当前播放时间更新所有 token span 的 `--sweep` CSS 变量，驱动卡拉OK式逐字高亮。
 * @param spans 与 tokens 一一对应的 span 元素数组。
 * @param tokens token 序列（含起止时间戳）。
 * @param timeMs 当前估计的播放时间（毫秒）。
 */
function updateTokenSweep(
  spans: HTMLSpanElement[],
  tokens: Array<{ text: string; start_ms: number; end_ms: number }>,
  timeMs: number,
) {
  tokens.forEach((token, i) => {
    const span = spans[i];
    if (!span) return;

    if (timeMs >= token.start_ms && timeMs <= token.end_ms) {
      // Currently playing token: calculate sweep progress
      const duration = Math.max(1, token.end_ms - token.start_ms);
      const progress = (timeMs - token.start_ms) / duration;
      span.style.setProperty('--sweep', Math.min(1, Math.max(0, progress)).toString());
    } else if (timeMs > token.end_ms) {
      // Already sung: fully highlighted
      span.style.setProperty('--sweep', '1');
    } else {
      // Not yet sung: no highlight
      span.style.setProperty('--sweep', '0');
    }
  });
}

/**
 * 以 token 形式渲染灵动岛收起态当前行，并由 `updateTokenSweep` 驱动高亮。
 * @param container 当前行文本容器（通常为 `#lyric-text-inner`）。
 * @param tokens 当前行的 token 序列。
 * @param currentTimeMs 当前估计的播放时间（毫秒）。
 */
function renderLyricWithTokens(container: HTMLElement, tokens: Array<{ text: string; start_ms: number; end_ms: number }>, currentTimeMs: number) {
  const nextKey = buildTokensKey(tokens);

  // Rebuild DOM only when lyric line/tokens changed
  if (currentLyricTokenKey !== nextKey || tokenSpans.length !== tokens.length || container.children.length !== tokens.length) {
    setCurrentLyricTokenKey(nextKey);
    container.innerHTML = '';
    setTokenSpans([]);

    tokens.forEach((token) => {
      const span = document.createElement('span');
      span.className = 'lyric-token';
      span.textContent = token.text;
      span.setAttribute('data-text', token.text);
      span.style.whiteSpace = 'pre';
      container.appendChild(span);
      tokenSpans.push(span);
    });
  }

  updateTokenSweep(tokenSpans, tokens, currentTimeMs);
}


/**
 * 以 token 形式渲染展开态音乐面板的当前行，实现与收起态一致的逐字 sweep 高亮。
 * @param container 音乐面板当前行的文本容器（`.mp-lyric-line-inner`）。
 * @param tokens 当前行的 token 序列。
 * @param currentTimeMs 当前估计的播放时间（毫秒）。
 */
function renderMpLyricWithTokens(
  container: HTMLElement,
  tokens: Array<{ text: string; start_ms: number; end_ms: number }>,
  currentTimeMs: number,
) {
  const nextKey = buildTokensKey(tokens);

  if (
    currentMpLyricTokenKey !== nextKey ||
    mpTokenSpans.length !== tokens.length ||
    container.children.length !== tokens.length
  ) {
    setCurrentMpLyricTokenKey(nextKey);
    container.textContent = '';
    setMpTokenSpans([]);

    tokens.forEach((token) => {
      const span = document.createElement('span');
      span.className = 'mp-lyric-token';
      span.textContent = token.text;
      span.setAttribute('data-text', token.text);
      span.style.whiteSpace = 'pre';
      container.appendChild(span);
      mpTokenSpans.push(span);
    });
  }

  updateTokenSweep(mpTokenSpans, tokens, currentTimeMs);
}


function getEstimatedLyricPositionMs(nowPerfMs: number): number {
  if (!isPlaying) return activeLyricBasePositionMs;
  const delta = nowPerfMs - activeLyricBasePerfMs;
  return activeLyricBasePositionMs + Math.max(0, delta);
}

export function resetIslandLyricScroll() {
  setLyricScrollLineStartMs(null);
  setLyricScrollNextLineTimeMs(null);
  setLyricScrollLastX(0);
  lyricTextInner.style.transform = "";
  if (mpCurrentLyricInner) mpCurrentLyricInner.style.transform = "";
}

function hasActiveIslandLyricScroll(): boolean {
  return lyricScrollLineStartMs !== null
    && lyricScrollNextLineTimeMs !== null
    && lyricScrollNextLineTimeMs > lyricScrollLineStartMs;
}

function applyIslandLyricScroll(positionMs: number) {
  if (!hasActiveIslandLyricScroll()) {
    if (lyricTextInner.style.transform !== "") lyricTextInner.style.transform = "";
    if (mpCurrentLyricInner && mpCurrentLyricInner.style.transform !== "") mpCurrentLyricInner.style.transform = "";
    setLyricScrollLastX(0);
    return;
  }

  const startMs = lyricScrollLineStartMs as number;
  const nextMs = lyricScrollNextLineTimeMs as number;
  const duration = Math.max(1, nextMs - startMs);
  const holdMs = duration >= 1000 ? 1000 : 0;
  const scrollStart = startMs + holdMs;
  const scrollEnd = Math.max(scrollStart + 1, nextMs - 500);
  const scrollDuration = Math.max(1, scrollEnd - scrollStart);
  const progress = positionMs < scrollStart
    ? 0
    : Math.min(1, (positionMs - scrollStart) / scrollDuration);

  // Island compact lyric scroll
  const overflow = Math.max(0, lyricTextInner.scrollWidth - lyricText.clientWidth);
  if (overflow <= 1) {
    if (lyricTextInner.style.transform !== "") lyricTextInner.style.transform = "";
    setLyricScrollLastX(0);
  } else {
    const x = -overflow * progress;
    if (Math.abs(x - lyricScrollLastX) > 0.2) {
      lyricTextInner.style.transform = `translateX(${x}px)`;
      setLyricScrollLastX(x);
    }
  }

  // Music panel current line scroll
  if (mpCurrentLyricInner && mpCurrentLyricOuter) {
    const mpOverflow = Math.max(0, mpCurrentLyricInner.scrollWidth - mpCurrentLyricOuter.clientWidth);
    if (mpOverflow <= 1) {
      if (mpCurrentLyricInner.style.transform !== "") mpCurrentLyricInner.style.transform = "";
    } else {
      mpCurrentLyricInner.style.transform = `translateX(${-mpOverflow * progress}px)`;
    }
  }
}

function ensureLyricTokenAnimationLoop() {
  if (tokenAnimationId !== null) return;
  setLyricFpsWindowStartMs(0);
  setLyricFpsFrameCount(0);

  const tick = (now: number) => {
    const hasTokens = !!activeLyricTokens && activeLyricTokens.length > 0;
    const hasScroll = hasActiveIslandLyricScroll();
    if (!hasTokens && !hasScroll) {
      setTokenAnimationId(null);
      return;
    }

    const estimatedPosMs = getEstimatedLyricPositionMs(now);
    if (hasTokens) {
      const tokens = activeLyricTokens as Array<{ text: string; start_ms: number; end_ms: number }>;
      renderLyricWithTokens(lyricTextInner, tokens, estimatedPosMs);
      // 同步更新音乐面板当前行的逐字 sweep
      if (mpCurrentLyricInner) {
        renderMpLyricWithTokens(mpCurrentLyricInner, tokens, estimatedPosMs);
      }
    }
    applyIslandLyricScroll(estimatedPosMs);

    if (lyricFpsWindowStartMs === 0) {
      setLyricFpsWindowStartMs(now);
      setLyricFpsFrameCount(0);
    }
    setLyricFpsFrameCount(lyricFpsFrameCount + 1);
    const elapsed = now - lyricFpsWindowStartMs;
    if (elapsed >= 2000) {
      const fps = (lyricFpsFrameCount * 1000) / elapsed;
      console.debug(`[LyricSweep] raf fps=${fps.toFixed(1)} playing=${isPlaying}`);
      setLyricFpsWindowStartMs(now);
      setLyricFpsFrameCount(0);
    }

    setTokenAnimationId(requestAnimationFrame(tick));
  };

  setTokenAnimationId(requestAnimationFrame(tick));
}

export function stopLyricTokenAnimationLoop() {
  if (tokenAnimationId !== null) {
    cancelAnimationFrame(tokenAnimationId);
    setTokenAnimationId(null);
  }
  setActiveLyricTokens(null);
}

function renderLyricPlainText(container: HTMLElement, text: string) {
  stopLyricTokenAnimationLoop();
  setCurrentLyricTokenKey("");
  setTokenSpans([]);
  if (container.textContent !== text || container.children.length > 0) {
    container.textContent = text;
  }
}

/** 为 nearby_lyrics 生成稳定 key：相同文本按出现次序追加序号，避免副歌重复导致匹配错乱 */
function buildLineKeys(nearby: Array<{ text: string; is_current: boolean }>): string[] {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  for (const l of nearby) {
    const c = counts.get(l.text) ?? 0;
    counts.set(l.text, c + 1);
    keys.push(`${l.text}#${c}`);
  }
  return keys;
}

/**
 * 以 FLIP（First-Last-Invert-Play）技术让多行歌词切换时像轨道一样平滑滚动：
 * 复用行做位移过渡，新行从底部淡入，退出行向上淡出。
 * 若 tokens 非空，则为当前行渲染逐字 token spans 以实现卡拉OK式 sweep 高亮。
 */
function renderNearbyLyricsFlip(
  nearby: Array<{ text: string; is_current: boolean }>,
  tokens: Array<{ text: string; start_ms: number; end_ms: number }> | null,
  currentTimeMs: number,
) {
  // 清理 prevLineMap 中已不在 DOM 的无效引用（可能被其他分支如 textContent="♪" 破坏过）
  for (const [k, el] of Array.from(prevLineMap)) {
    if (!mpLyricText.contains(el)) prevLineMap.delete(k);
  }
  // 若此时 mpLyricText 里是文本节点（如 "♪"）或已无行元素，清空作为全新入场
  if (prevLineMap.size === 0) {
    while (mpLyricText.firstChild) mpLyricText.removeChild(mpLyricText.firstChild);
  }

  const keys = buildLineKeys(nearby);

  // ===== FIRST：记录所有旧行的矩形位置（读布局） =====
  const oldRects = new Map<HTMLElement, DOMRect>();
  for (const el of prevLineMap.values()) {
    oldRects.set(el, el.getBoundingClientRect());
  }

  // ===== 分类：reused（复用）/ entering（新增）/ exiting（稍后从剩余 prevLineMap 中得出） =====
  const newMap = new Map<string, HTMLElement>();
  const reusedEls: HTMLElement[] = [];
  const enteringEls: HTMLElement[] = [];
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < nearby.length; i++) {
    const key = keys[i];
    const line = nearby[i];
    let el = prevLineMap.get(key);
    let isNew = false;
    if (el) {
      prevLineMap.delete(key);
      reusedEls.push(el);
    } else {
      el = document.createElement("div");
      el.textContent = line.text;
      enteringEls.push(el);
      isNew = true;
    }
    // 清除可能残留的 inline 样式（上一次动画的尾巴）
    el.style.position = "";
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.transition = "";
    el.style.transform = "";
    // 更新 class：mp-lyric-line [+ mp-lyric-current] [+ entering]
    let cls = "mp-lyric-line";
    if (line.is_current) cls += " mp-lyric-current";
    if (isNew) cls += " entering";
    el.className = cls;
    // Current line: use inner span for horizontal scroll; others: plain text with ellipsis
    if (line.is_current) {
      let inner = el.querySelector(".mp-lyric-line-inner") as HTMLSpanElement | null;
      if (!inner) {
        el.textContent = "";
        inner = document.createElement("span");
        inner.className = "mp-lyric-line-inner";
        el.appendChild(inner);
      }
      if (mpCurrentLyricInner !== inner) {
        inner.style.transform = '';
        // 新的当前行容器：清除旧 token spans 缓存，强制重建
        setMpTokenSpans([]);
        setCurrentMpLyricTokenKey('');
      }
      if (tokens && tokens.length > 0) {
        // 使用逐字 token 渲染（卡拉OK式 sweep）
        renderMpLyricWithTokens(inner, tokens, currentTimeMs);
      } else {
        // 无 token：回退到整行纯文本；若上一次是 token 模式，清空缓存并重置内容
        if (inner.children.length > 0 || inner.textContent !== line.text) {
          inner.textContent = line.text;
        }
        setMpTokenSpans([]);
        setCurrentMpLyricTokenKey('');
      }
      setMpCurrentLyricInner(inner);
      setMpCurrentLyricOuter(el);
    } else {
      if (el.querySelector(".mp-lyric-line-inner")) {
        el.textContent = line.text;
      } else if (el.textContent !== line.text) {
        el.textContent = line.text;
      }
    }
    newMap.set(key, el);
    fragment.appendChild(el);
  }

  // 剩下的 prevLineMap 即是 exiting 集合
  const exitingEls: HTMLElement[] = Array.from(prevLineMap.values());

  // ===== 直接移除 exiting 元素，不做移出动画 =====
  for (const el of exitingEls) {
    if (el.parentNode) el.remove();
  }

  // ===== LAST：将复用/新增元素按新顺序插入容器（复用元素会被移动到新位置） =====
  mpLyricText.appendChild(fragment);

  // 强制 reflow，让浏览器计算出复用元素的新 rect
  void mpLyricText.offsetHeight;

  // ===== INVERT：对复用元素设置反向 translate，使其视觉上"留在原位" =====
  for (const el of reusedEls) {
    const oldRect = oldRects.get(el);
    if (!oldRect) continue;
    const newRect = el.getBoundingClientRect();
    const dy = oldRect.top - newRect.top;
    if (dy !== 0) {
      const isCurrent = el.classList.contains("mp-lyric-current");
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px) scale(${isCurrent ? 1.05 : 1})`;
    }
  }

  // 再次 reflow，确保上一步的 inline 样式被浏览器采纳
  void mpLyricText.offsetHeight;

  // ===== PLAY：下一帧清空 inline、去掉 entering、给 exiting 打标记，让 CSS transition 接管 =====
  requestAnimationFrame(() => {
    for (const el of reusedEls) {
      el.style.transition = "";
      el.style.transform = "";
    }
    for (const el of enteringEls) {
      el.classList.remove("entering");
    }
  });

  setPrevLineMap(newMap);
}

/** 当 mpLyricText 被其他分支覆盖成纯文本（如 "♪"、歌名）时调用，丢弃 FLIP 状态 */
export function resetMpLyricFlipState() {
  prevLineMap.clear();
  // mpLyricText 的 children 已被清空，这些引用都已失效；同步清理 token 缓存
  setMpCurrentLyricInner(null);
  setMpCurrentLyricOuter(null);
  setMpTokenSpans([]);
  setCurrentMpLyricTokenKey('');
}

export function initLyricRenderer() {

  listen<string>("lyric-mode-changed", (event) => {
    setLyricMode(event.payload);
    updateSwitcherUI();
  });

  listen<{ text: string | null; title: string; artist: string; genre?: string; position_ms?: number; duration_ms?: number; is_playing?: boolean; seekable?: boolean; nearby_lyrics?: Array<{ text: string; is_current: boolean }>; tokens?: Array<{ text: string; start_ms: number; end_ms: number }>; line_start_ms?: number; next_line_time_ms?: number } | null>("lyric-update", (event) => {

    if (event.payload === null) {
      setIsMusicPlaying(false);
      setIsPlaying(false);
      updatePlayIcon();

      updateSwitcherUI();
      resetIslandLyricScroll();
      stopLyricTokenAnimationLoop();
      return;
    }

    setIsMusicPlaying(true);
    const { text, title, artist, position_ms, duration_ms } = event.payload;
    if (position_ms !== undefined) {
      setActiveLyricBasePositionMs(position_ms);
      setActiveLyricBasePerfMs(performance.now());
    }

    // 从 lyric-update 同步播放状态，避免 playback-state 事件丢失
    if (event.payload.is_playing !== undefined && event.payload.is_playing !== isPlaying) {
      setIsPlaying(event.payload.is_playing);
      updatePlayIcon();
    }

    // 同步 seekable 状态
    if (event.payload.seekable !== undefined) {
      updateSeekable(event.payload.seekable);
    }

    // 更新进度条（收起态 + 面板）
    if (duration_ms && duration_ms > 0 && position_ms !== undefined) {
      setCurrentDurationMs(duration_ms);
      const pct = Math.min(100, Math.max(0, (position_ms / duration_ms) * 100));
      if (!isSeeking) {
        progressFill.style.width = `${pct}%`;
        progressThumb.style.left = `${pct}%`;
      }
      if (!isMpSeeking) {
        mpProgressFill.style.width = `${pct}%`;
        mpProgressThumb.style.left = `${pct}%`;
        mpTimeCurrent.textContent = formatTime(position_ms);
        mpTimeTotal.textContent = formatTime(duration_ms);
      }
    }

    if (lyricMode === "info" || text === null) {
      resetIslandLyricScroll();
      renderLyricPlainText(lyricTextInner, text?.trim() || "暂无歌词");
      lyricMeta.textContent = artist ? `${title} · ${artist}` : title;
      lyricMeta.style.fontSize = "";
      lyricMeta.style.color = "";
    } else {
      lyricMeta.style.fontSize = "";
      lyricMeta.style.color = "";
      lyricMeta.textContent = artist ? `${title} · ${artist}` : title;
      if (event.payload.line_start_ms !== undefined && event.payload.next_line_time_ms !== undefined) {
        if (lyricScrollLineStartMs !== event.payload.line_start_ms) {
          lyricTextInner.style.transform = "";
          if (mpCurrentLyricInner) mpCurrentLyricInner.style.transform = "";
          setLyricScrollLastX(0);
        }
        setLyricScrollLineStartMs(event.payload.line_start_ms);
        setLyricScrollNextLineTimeMs(event.payload.next_line_time_ms);
        applyIslandLyricScroll(position_ms ?? activeLyricBasePositionMs);
        ensureLyricTokenAnimationLoop();
      } else {
        resetIslandLyricScroll();
      }

      // Handle token-based highlighting for compact lyric view
      const tokens = event.payload.tokens;
      if (tokens && tokens.length > 0 && position_ms !== undefined) {
        setActiveLyricTokens(tokens);
        renderLyricWithTokens(lyricTextInner, tokens, position_ms);
        ensureLyricTokenAnimationLoop();
      } else {
        setActiveLyricTokens(null);
        setCurrentLyricTokenKey("");
        setTokenSpans([]);
        // Fallback to plain text rendering
        if (lyricTextInner.children.length > 0) {
          renderLyricPlainText(lyricTextInner, text);
          applyIslandLyricScroll(position_ms ?? activeLyricBasePositionMs);
          ensureLyricTokenAnimationLoop();
        } else if (lyricTextInner.textContent !== text) {
          lyricText.classList.add("fade");
          window.setTimeout(() => {
            renderLyricPlainText(lyricTextInner, text);
            applyIslandLyricScroll(position_ms ?? activeLyricBasePositionMs);
            ensureLyricTokenAnimationLoop();
            lyricText.classList.remove("fade");
          }, 140);
        } else {
          applyIslandLyricScroll(position_ms ?? activeLyricBasePositionMs);
          ensureLyricTokenAnimationLoop();
        }
      }
    }

    // 同步歌词到展开面板（多行）— 使用 FLIP 技术做轨道式平滑滚动
    const nearby = event.payload.nearby_lyrics;
    const mpTokens = event.payload.tokens ?? null;
    const mpCurrentTimeMs = position_ms ?? activeLyricBasePositionMs;
    if (nearby && nearby.length > 0) {
      renderNearbyLyricsFlip(nearby, mpTokens, mpCurrentTimeMs);
    } else if (text !== null && text !== undefined) {
      // 前奏/等待歌词阶段：强制显示音乐符号，避免残留多行歌词造成"提前显示后续歌词"
      if (text === "♪") {
        mpLyricText.textContent = "♪";
        resetMpLyricFlipState();
      } else {
        // 如果面板已有多行歌词槽位，不用单行文本覆盖
        if (mpLyricText.children.length === 0) {
          mpLyricText.textContent = text;
          resetMpLyricFlipState();
        }
      }
    } else {
      mpLyricText.textContent = title;
      resetMpLyricFlipState();
    }

    updateSwitcherUI();
  });

}
