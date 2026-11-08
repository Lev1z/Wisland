// In-WebView listbox: native <select> popups size themselves to the longest label
// and can extend beyond a narrow desktop window.
export type SessionOption = { value: string; title: string; subtitle: string; branch?: boolean };

export class SessionPicker {
  private button = document.getElementById("runtime-session") as HTMLButtonElement;
  private label = document.getElementById("runtime-session-label")!;
  private panel = document.getElementById("runtime-sessions")!;
  private wrapper = document.getElementById("session-picker")!;
  private options: SessionOption[] = [];
  private value = "";
  private active = "";
  private key = "";
  constructor(private choose: (value: string) => void) {
    this.button.addEventListener("click", () => this.panel.hidden ? this.open() : this.close());
    this.button.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.close()) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === "Tab") { this.close(false); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      if (this.panel.hidden) { this.open(); return; }
      if (event.key === "Enter" || event.key === " ") { this.select(this.active); return; }
      const index = this.options.findIndex(option => option.value === this.active);
      const next = event.key === "Home" ? 0 : event.key === "End" ? this.options.length - 1 : Math.max(0, Math.min(this.options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      this.active = this.options[next]?.value ?? "";
      this.highlight(true);
    });
    document.addEventListener("pointerdown", event => { if (!this.wrapper.contains(event.target as Node)) this.close(false); });
    this.wrapper.addEventListener("focusout", event => { if (!this.wrapper.contains(event.relatedTarget as Node)) this.close(false); });
    new ResizeObserver(() => this.size()).observe(document.getElementById("details")!);
    // Quota rows can appear/disappear without resizing the native window.
    new ResizeObserver(() => this.size()).observe(document.getElementById("runtime")!);
    new ResizeObserver(() => this.size()).observe(this.wrapper);
  }
  update(options: SessionOption[], value: string, caption: string, tooltip: string): void {
    this.value = value;
    this.label.textContent = caption;
    this.button.title = tooltip;
    const key = JSON.stringify(options);
    if (key !== this.key) {
      const top = this.panel.scrollTop;
      this.options = options; this.key = key;
      if (!options.some(option => option.value === this.active)) this.active = value;
      this.panel.replaceChildren(...options.map((option, index) => {
        const row = document.createElement("div");
        row.className = "session-option"; row.id = `session-option-${index}`;
        row.dataset.value = option.value; row.dataset.branch = String(!!option.branch);
        row.setAttribute("role", "option"); row.title = `${option.title}\n${option.subtitle}`;
        const title = document.createElement("span"); title.className = "session-option-title"; title.textContent = option.title;
        const subtitle = document.createElement("span"); subtitle.className = "session-option-subtitle"; subtitle.textContent = option.subtitle;
        row.append(title, subtitle);
        row.addEventListener("pointerdown", event => event.preventDefault()); // Keep combobox keyboard focus.
        row.addEventListener("click", () => this.select(option.value));
        row.addEventListener("pointermove", () => { this.active = option.value; this.highlight(false); });
        return row;
      }));
      this.panel.scrollTop = top;
    }
    this.highlight(false);
  }
  close(focus = true): boolean {
    if (this.panel.hidden) return false;
    this.panel.hidden = true; this.button.setAttribute("aria-expanded", "false");
    this.button.removeAttribute("aria-activedescendant");
    if (focus) this.button.focus({ preventScroll: true });
    return true;
  }
  private open(): void {
    this.panel.hidden = false; this.active = this.value;
    this.button.setAttribute("aria-expanded", "true");
    this.size(); this.highlight(true);
  }
  private size(): void {
    if (this.panel.hidden) return;
    const top = this.panel.getBoundingClientRect().top;
    const bottom = Math.min(innerHeight, document.getElementById("details")!.getBoundingClientRect().bottom) - 16;
    this.panel.style.maxHeight = `${Math.max(0, Math.min(360, bottom - top))}px`;
  }
  private highlight(scroll: boolean): void {
    for (const row of this.panel.querySelectorAll<HTMLElement>(".session-option")) {
      row.setAttribute("aria-selected", String(row.dataset.value === this.value));
      const active = row.dataset.value === this.active;
      row.dataset.active = String(active);
      if (active && !this.panel.hidden) {
        this.button.setAttribute("aria-activedescendant", row.id);
        if (scroll) row.scrollIntoView({ block: "nearest" });
      }
    }
  }
  private select(value: string): void { this.close(); this.choose(value); }
}
