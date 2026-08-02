import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import {
  capsule,
  fileDropOverlay,
  trayContextMenu,
  trayCopy,
  trayCount,
  trayEmpty,
  trayList,
  trayRemove,
} from "../dom";
import { setUserChosenView } from "../state";
import { showNotice } from "./notice-queue";
import { setView } from "./view-switcher";

const MAX_FILES = 24;
const paths: string[] = [];
let selectedPath: string | null = null;

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1, index + 5).toUpperCase() : "FILE";
}

function setDropActive(active: boolean): void {
  fileDropOverlay.classList.toggle("active", active);
  capsule.classList.toggle("file-drop-active", active);
  if (active) capsule.classList.add("expanded");
  void invoke("set_interacting", { active });
}

function pointInsideCapsule(position: { x: number; y: number }): boolean {
  const ratio = window.devicePixelRatio || 1;
  const x = position.x / ratio;
  const y = position.y / ratio;
  const rect = capsule.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
  const radius = Math.min(rect.height / 2, 28);
  const nearestX = Math.max(rect.left + radius, Math.min(x, rect.right - radius));
  const nearestY = Math.max(rect.top + radius, Math.min(y, rect.bottom - radius));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function hideContextMenu(): void {
  trayContextMenu.hidden = true;
}

function select(path: string): void {
  selectedPath = path;
  for (const row of trayList.querySelectorAll<HTMLElement>(".tray-file")) {
    row.classList.toggle("selected", row.dataset.path === path);
  }
}

function render(): void {
  trayCount.textContent = String(paths.length);
  trayEmpty.classList.toggle("visible", paths.length === 0);
  trayList.replaceChildren();

  for (const path of paths) {
    const row = document.createElement("div");
    row.className = `tray-file${path === selectedPath ? " selected" : ""}`;
    row.dataset.path = path;
    row.role = "listitem";
    row.title = path;

    const badge = document.createElement("span");
    badge.className = "tray-file-badge";
    badge.textContent = extension(path);
    const name = document.createElement("span");
    name.className = "tray-file-name";
    name.textContent = basename(path);
    row.append(badge, name);

    row.addEventListener("click", (event) => {
      event.stopPropagation();
      select(path);
      hideContextMenu();
    });
    row.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      void invoke("open_staged_file", { path }).catch((error) => showNotice(String(error), "error"));
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      select(path);
      const bounds = trayList.getBoundingClientRect();
      trayContextMenu.style.left = `${Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - 92))}px`;
      trayContextMenu.style.top = `${Math.max(0, event.clientY - bounds.top - 4)}px`;
      trayContextMenu.hidden = false;
    });
    trayList.appendChild(row);
  }
}

function stageFiles(incoming: string[]): void {
  let added = 0;
  for (const path of incoming) {
    if (paths.includes(path) || paths.length >= MAX_FILES) continue;
    paths.push(path);
    added += 1;
  }
  render();
  setUserChosenView("tray");
  setView("tray", true);
  capsule.classList.add("expanded");
  if (added === 0 && incoming.length > 0) {
    showNotice(paths.length >= MAX_FILES ? `临时托盘最多保留 ${MAX_FILES} 项` : "文件已在临时托盘中", "attention");
  }
}

function handleDragDrop(event: { payload: DragDropEvent }): void {
  const payload = event.payload;
  if (payload.type === "leave") {
    setDropActive(false);
    return;
  }
  const inside = pointInsideCapsule(payload.position);
  if (payload.type === "enter" || payload.type === "over") {
    setDropActive(inside);
    return;
  }
  setDropActive(false);
  if (inside) stageFiles(payload.paths);
}

export function initFileTray(): void {
  render();
  void getCurrentWindow().onDragDropEvent(handleDragDrop);

  trayCopy.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!selectedPath) return;
    try {
      await navigator.clipboard.writeText(selectedPath);
      hideContextMenu();
      showNotice("文件路径已复制", "success");
    } catch (error) {
      showNotice(`复制失败：${String(error)}`, "error");
    }
  });

  trayRemove.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!selectedPath) return;
    const index = paths.indexOf(selectedPath);
    if (index >= 0) paths.splice(index, 1);
    selectedPath = null;
    hideContextMenu();
    render();
  });

  capsule.addEventListener("click", hideContextMenu);
}
