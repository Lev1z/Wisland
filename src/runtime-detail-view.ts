import { Marked } from "marked";
import DOMPurify from "dompurify";
import { overviewFor, type DetailBlock, type EventDetail, type Fact } from "./runtime-detail";

const escape = (value: string): string => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
// Raw HTML is literal text. No remote resources or navigation from log content.
// Sanitization is a second boundary, not a substitute for these renderers.
const markdown = new Marked({ gfm: true, breaks: false, renderer: {
  html: ({ text }) => escape(text),
  image: ({ text }) => `<span>[图片：${escape(text || "未提供说明")}]</span>`,
  link({ href, tokens }) { return `<span title="${escape(href)}">${this.parser.parseInline(tokens)}</span>`; },
} });
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function action(text: string, label: string, click: () => void): HTMLButtonElement {
  const el = node("button", "detail-action", text); el.type = "button";
  el.setAttribute("aria-label", label); el.addEventListener("click", click); return el;
}
function factList(facts: Fact[]): HTMLElement {
  const dl = node("dl", "detail-facts");
  for (const fact of facts) {
    const row = node("div"); const value = node("dd", "", fact.value);
    if (fact.tone) value.dataset.tone = fact.tone;
    row.append(node("dt", "", fact.label), value); dl.append(row);
  }
  return dl;
}
export function detailTitle(detail: EventDetail): string { return overviewFor(detail).title; }

// Disconnect before replacing the DOM. Keeping expansion state by semantic
// section ID prevents a late related result from collapsing what is being read.
export function renderDetailContent(container: HTMLElement, detail: EventDetail, raw: boolean, reset: boolean): () => void {
  const expanded = reset ? new Map<string, boolean>() : new Map([...container.querySelectorAll<HTMLElement>("[data-expanded]")].map(e => [e.dataset.section!, e.dataset.expanded === "true"]));
  const opened = reset ? new Set<string>() : new Set([...container.querySelectorAll<HTMLDetailsElement>("details[open]")].map(e => e.dataset.section!));
  const focused = reset ? undefined : (document.activeElement as HTMLElement)?.dataset.detailFocus;
  const scroll = reset ? 0 : container.scrollTop;
  const nodes: HTMLElement[] = [];
  const previews: { body: HTMLElement; button: HTMLButtonElement; section: HTMLElement }[] = [];
  let alive = true;
  const section = (block: DetailBlock): HTMLElement => {
    const outer = block.secondary ? node("details", "detail-section detail-secondary") : node("section", "detail-section");
    outer.dataset.section = block.id;
    if (block.error) outer.dataset.tone = "error";
    if (outer instanceof HTMLDetailsElement) outer.open = opened.has(block.id);
    const heading = node(block.secondary ? "summary" : "div", "detail-section-heading");
    heading.append(node("span", "detail-section-title", block.title));
    const copy = action("复制", `复制${block.title}`, () => {
      // Clipboard writes require an explicit click; failures stay in the UI.
      void (async () => {
        try { await navigator.clipboard.writeText(block.text); if (alive) copy.textContent = "已复制"; }
        catch { if (alive) copy.textContent = "复制失败"; }
      })();
    });
    copy.dataset.detailFocus = `${block.id}-copy`;
    if (!block.secondary) heading.append(copy);
    outer.append(heading);
    if (block.secondary) outer.append(copy);
    if (block.facts?.length) outer.append(factList(block.facts));
    const body = node("div", `detail-preview ${block.format === "markdown" ? "detail-prose" : "detail-code"}`);
    if (block.format === "markdown") {
      try {
        body.append(DOMPurify.sanitize(markdown.parse(block.text, { async: false }), {
          ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "span"],
          ALLOWED_ATTR: ["title", "start"], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
        }));
      } catch { body.append(node("pre", "", block.text)); }
    } else { body.append(node("pre", "", block.text)); }
    // Raw records start fully open, including a mirror arriving on a later
    // snapshot. Preserve an explicit collapse while the same tab is updating.
    outer.dataset.expanded = String(expanded.get(block.id) ?? raw);
    const toggle = action("展开全部", `展开${block.title}`, () => {
      const open = outer.dataset.expanded !== "true";
      outer.dataset.expanded = String(open); toggle.textContent = open ? "收起" : "展开全部";
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", `${open ? "收起" : "展开"}${block.title}`);
    });
    toggle.classList.add("detail-expand"); toggle.dataset.detailFocus = `${block.id}-expand`;
    toggle.setAttribute("aria-expanded", outer.dataset.expanded);
    if (outer.dataset.expanded === "true") toggle.textContent = "收起";
    toggle.hidden = true;
    outer.append(body, toggle);
    previews.push({ body, button: toggle, section: outer });
    return outer;
  };
  const model = overviewFor(detail);
  if (raw) {
    nodes.push(section({ id: "raw", title: "JSONL 记录", format: "json", text: JSON.stringify(detail.detail.raw, null, 2) }));
    if (detail.detail.mirror) nodes.push(section({ id: "mirror", title: "合并的另一条源记录", format: "json", text: JSON.stringify(detail.detail.mirror, null, 2) }));
  } else {
    if (model.facts.length) nodes.push(factList(model.facts));
    nodes.push(...model.blocks.map(section));
    nodes.push(section({ id: "technical", title: "技术信息", format: "json", text: JSON.stringify(model.technical, null, 2), secondary: true }));
  }
  nodes.push(node("p", "detail-limit-note", "仅展示已保留的日志内容（限长）；二进制 / 加密字段省略。"));
  container.replaceChildren(...nodes);
  const measure = (): void => {
    for (const { body, button, section } of previews) {
      if (!body.getClientRects().length) continue;
      const open = section.dataset.expanded === "true";
      const overflow = body.scrollHeight > body.clientHeight + 1;
      button.hidden = !open && !overflow;
      section.dataset.clipped = String(!open && overflow);
    }
  };
  const observer = new ResizeObserver(measure);
  previews.forEach(({ body }) => observer.observe(body));
  measure();
  if (focused) [...container.querySelectorAll<HTMLElement>("[data-detail-focus]")].find(e => e.dataset.detailFocus === focused)?.focus({ preventScroll: true });
  container.scrollTop = scroll;
  return () => { alive = false; observer.disconnect(); };
}
