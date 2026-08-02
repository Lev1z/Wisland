import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  capsule,
  collapsedIndicator,
} from "../dom";
import {
  isMinimized, setIsMinimized,
  isMinimizeAnimating, setIsMinimizeAnimating,
  isDragging, setIsDragging,
  dragStarted, setDragStarted,
  lastX, setLastX,
  lastY, setLastY,
  mouseDownX, setMouseDownX,
  mouseDownY, setMouseDownY,
  DRAG_THRESHOLD,
} from "../state";

// ===== 收起/展开功能 =====

export function applyIndicatorColor(color: string) {

  collapsedIndicator.style.background = `linear-gradient(90deg, ${color}dd, ${color}, ${color}dd)`;

  collapsedIndicator.style.boxShadow = `0 0 8px ${color}80`;

}



export function minimizeIsland() {

  if (isMinimized || isMinimizeAnimating) return;

  setIsMinimized(true);

  setIsMinimizeAnimating(true);



  capsule.classList.add("minimizing");



  setTimeout(() => {

    capsule.classList.remove("minimizing");

    capsule.classList.add("minimized");

    document.body.classList.add("minimized");

    void invoke("set_minimized", { minimized: true });

    setIsMinimizeAnimating(false);

  }, 300);

}



export function expandFromMinimized() {

  if (!isMinimized || isMinimizeAnimating) return;

  setIsMinimized(false);

  setIsMinimizeAnimating(true);



  void invoke("set_minimized", { minimized: false });



  document.body.classList.remove("minimized");



  capsule.classList.remove("minimized");

  capsule.classList.add("expanding");



  setTimeout(() => {

    capsule.classList.remove("expanding");

    setIsMinimizeAnimating(false);

  }, 300);

}



// ===== 右键菜单 =====

export function showContextMenu() {

  // 使用后端显示系统菜单

  void invoke("show_context_menu");

}



export function initMinimizeDrag() {

  // 监听菜单动作

  listen<string>("context-menu-action", (event) => {

    const action = event.payload;

    if (action === "minimize") {

      minimizeIsland();

    } else if (action === "settings") {

      // 延迟执行，确保菜单完全关闭后再打开设置窗口

      setTimeout(() => {

        void invoke("open_settings");

      }, 100);

    }

  });


  listen<string>("indicator-color-changed", (event) => {

    applyIndicatorColor(event.payload);

  });



  capsule.addEventListener("mousedown", (e: MouseEvent) => {

    // 右键不触发拖动

    if (e.button !== 0) return;

    const target = e.target as HTMLElement;

    if (target.closest(".url-item") || target.closest("#notice-area") || target.closest("#quick-note-area") || target.closest(".media-btn") || target.closest(".view-dot")) {

      return;

    }

    setIsDragging(true);

    setDragStarted(false);

    setLastX(e.screenX);

    setLastY(e.screenY);

    setMouseDownX(e.screenX);

    setMouseDownY(e.screenY);

  });



  // 绿条点击展开

  collapsedIndicator.addEventListener("click", (e: MouseEvent) => {

    e.stopPropagation();

    expandFromMinimized();

  });



  document.addEventListener("mousemove", (e: MouseEvent) => {

    if (!isDragging) return;



    const dx = e.screenX - lastX;

    const dy = e.screenY - lastY;



    // 检查是否超过拖动阈值

    if (!dragStarted) {

      const totalDx = Math.abs(e.screenX - mouseDownX);

      const totalDy = Math.abs(e.screenY - mouseDownY);

      if (totalDx < DRAG_THRESHOLD && totalDy < DRAG_THRESHOLD) return;

      setDragStarted(true);

      void invoke("start_drag");

    }



    setLastX(e.screenX);

    setLastY(e.screenY);



    if (dx !== 0 || dy !== 0) {

      void invoke("drag_move", { dx, dy });

    }

  });



  document.addEventListener("mouseup", () => {

    if (!isDragging) return;

    setIsDragging(false);

    if (dragStarted) {

      void invoke("end_drag");

      // 不立即重置 dragStarted，留给 click handler 检测并阻断点击

      // 安全兜底：如果 click 事件未触发（如焦点丢失），100ms 后自动重置

      window.setTimeout(() => { setDragStarted(false); }, 100);

    }

  });

}
