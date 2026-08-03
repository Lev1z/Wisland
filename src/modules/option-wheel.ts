export type OptionWheelSelectHandler = (index: number) => void;

type DragState = {
  pointerId: number;
  startY: number;
  startTarget: number;
};

/**
 * A small DOM adaptation of React Bits' Option Wheel motion model.
 * Wisland uses icon buttons instead of text labels and keeps the wheel inside
 * the capsule's compact left rail, without adding a React runtime dependency.
 */
export class OptionWheelController {
  private readonly root: HTMLElement;
  private readonly onSelect: OptionWheelSelectHandler;
  private items: HTMLElement[] = [];
  private enabled = false;
  private position = 0;
  private target = 0;
  private selected = 0;
  private animationFrame: number | null = null;
  private lastFrame = 0;
  private drag: DragState | null = null;
  private dragMoved = false;

  constructor(root: HTMLElement, onSelect: OptionWheelSelectHandler) {
    this.root = root;
    this.onSelect = onSelect;
    root.addEventListener("wheel", this.handleWheel, { passive: false });
    root.addEventListener("pointerdown", this.handlePointerDown);
    root.addEventListener("pointermove", this.handlePointerMove);
    root.addEventListener("pointerup", this.handlePointerEnd);
    root.addEventListener("pointercancel", this.handlePointerEnd);
    root.addEventListener("keydown", this.handleKeyDown);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.classList.toggle("option-wheel", enabled);
    this.root.tabIndex = enabled ? 0 : -1;
    if (enabled) {
      this.root.role = "listbox";
      this.root.setAttribute("aria-label", "Option Wheel 页面选择器");
      this.layout();
    } else {
      this.root.removeAttribute("role");
      this.root.removeAttribute("aria-label");
      this.stopAnimation();
    }
  }

  setItems(items: HTMLElement[], selectedIndex: number, snap = false): void {
    this.items = items;
    this.selected = this.clampIndex(selectedIndex);
    if (snap || !Number.isFinite(this.position)) this.position = this.selected;
    this.target = this.selected;
    this.updateSelectionState();
    this.startAnimation();
  }

  select(index: number): void {
    if (!this.enabled || this.dragMoved) return;
    this.commit(index);
  }

  private clampIndex(index: number): number {
    return Math.max(0, Math.min(this.items.length - 1, Math.round(index)));
  }

  private commit(index: number): void {
    const next = this.clampIndex(index);
    this.selected = next;
    this.target = next;
    this.updateSelectionState();
    this.startAnimation();
    this.onSelect(next);
  }

  private updateSelectionState(): void {
    this.items.forEach((item, index) => {
      const active = index === this.selected;
      item.classList.toggle("active", active);
      item.classList.toggle("option-wheel__item--selected", active);
      item.setAttribute("aria-selected", String(active));
    });
  }

  private startAnimation(): void {
    if (!this.enabled || this.items.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.position = this.target;
      this.layout();
      return;
    }
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.lastFrame = performance.now();
    this.animationFrame = requestAnimationFrame(this.runFrame);
  }

  private stopAnimation(): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  private runFrame = (now: number): void => {
    const elapsed = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    const smoothingSeconds = 0.11;
    const easing = 1 - Math.exp(-elapsed / smoothingSeconds);
    this.position += (this.target - this.position) * easing;
    if (Math.abs(this.target - this.position) < 0.001) this.position = this.target;
    this.layout();
    this.animationFrame = this.position === this.target
      ? null
      : requestAnimationFrame(this.runFrame);
  };

  private layout(): void {
    if (!this.enabled || this.items.length === 0) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    const rowHeight = Math.max(2.25 * rem, 1);
    const tiltRadians = 12 * Math.PI / 180;
    const radius = rowHeight / tiltRadians;

    this.items.forEach((item, index) => {
      const delta = index - this.position;
      const distance = Math.abs(delta);
      const angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, delta * tiltRadians));
      const y = radius * Math.sin(angle);
      const x = radius * (1 - Math.cos(angle)) * 0.38;
      const rotation = -angle * 180 / Math.PI * 0.55;
      const prominence = Math.max(0, 1 - Math.min(distance, 1));
      item.style.transform = `translate3d(${x.toFixed(2)}px, calc(${y.toFixed(2)}px - 50%), 0) rotate(${rotation.toFixed(2)}deg)`;
      item.style.opacity = String(Math.max(0.14, 1 - distance * 0.24));
      item.style.filter = distance < 0.15 ? "none" : `blur(${(distance * 0.55).toFixed(2)}px)`;
      item.style.setProperty("--ow-p", prominence.toFixed(3));
    });
  }

  private handleWheel = (event: WheelEvent): void => {
    if (!this.enabled || Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    event.stopPropagation();
    this.commit(this.selected + (event.deltaY > 0 ? 1 : -1));
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0) return;
    this.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTarget: this.target,
    };
    this.dragMoved = false;
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.drag || this.drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - this.drag.startY;
    if (!this.dragMoved && Math.abs(deltaY) > 4) {
      this.dragMoved = true;
      this.root.classList.add("option-wheel--dragging");
      this.root.setPointerCapture(event.pointerId);
    }
    if (!this.dragMoved) return;
    event.stopPropagation();
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
    this.target = Math.max(0, Math.min(this.items.length - 1, this.drag.startTarget - deltaY / (2.25 * rem)));
    this.startAnimation();
  };

  private handlePointerEnd = (event: PointerEvent): void => {
    if (!this.enabled || !this.drag || this.drag.pointerId !== event.pointerId) return;
    const moved = this.dragMoved;
    this.drag = null;
    this.root.classList.remove("option-wheel--dragging");
    if (this.root.hasPointerCapture(event.pointerId)) this.root.releasePointerCapture(event.pointerId);
    if (moved) this.commit(this.target);
    window.setTimeout(() => { this.dragMoved = false; }, 0);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    let direction = 0;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") direction = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") direction = 1;
    if (direction === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.commit(this.selected + direction);
  };
}
