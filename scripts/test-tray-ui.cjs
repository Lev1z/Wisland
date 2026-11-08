// Local UI regression test; uses mocked IPC, never reads or changes account data.
// npm install --prefix target/tray-qa-tools --no-save --package-lock=false playwright@1.56.1
// npm run build && node scripts/test-tray-ui.cjs
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '../dist');
const output = path.resolve(__dirname, '../target/tray-ui-qa');
const quotaWindow = (remainingPercent) => ({ remainingPercent, resetsAt: Math.floor(Date.now() / 1000) + 8300 });
const cases = [
  { name: 'dual', phase: 'running', five: 68, week: 41, available: true, count: 2 },
  { name: 'weekly-only', phase: 'idle', five: null, week: 95, available: true, count: 1 },
  { name: 'offline', phase: 'stale', five: null, week: null, available: false, count: 2 },
  { name: 'stale', phase: 'idle', five: 20, week: 30, available: true, stale: true, count: 2 },
  { name: 'boundaries', phase: 'running', five: 0, week: 100, available: true, count: 2 },
  { name: 'unknown-windows', phase: 'idle', five: null, week: null, available: true, count: 0 },
];

async function main() {
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    const target = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(target)];
      response.setHeader('Content-Type', type ?? 'application/octet-stream');
      response.end(await fs.readFile(target));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  let passed = 0;
  try {
    for (const scale of [1, 1.25, 2]) for (const theme of ['dark', 'light']) for (const scenario of cases) {
      const context = await browser.newContext({ viewport: { width: 525, height: 850 }, deviceScaleFactor: scale, colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript((snapshot) => {
        const callbacks = new Map();
        const listeners = new Map();
        let serial = 0;
        const runtime = {
          revision: 1, sessionId: 'test-session', automatic: true,
          sessions: [{ id: 'test-session', label: '优化 Wisland Runtime 侧栏', fileName: 'rollout-test-session.jsonl', threadId: '019a6b3c-1234-5678-9abc-0123456789ab', modified: 1 }],
          notice: '只读时间线 · 圆点标注已记录的模型完成调用', error: null,
          turnStatus: { t1: 'completed', t2: 'started' },
          events: Array.from({ length: 72 }, (_, i) => ({
            id: String(i), turnId: i < 36 ? 't1' : 't2', turnNumber: i < 36 ? 1 : 2,
            modelCall: i % 12 === 11 ? { responseId: `resp-${i}`, number: Math.floor(i / 12) + 1 } : null,
            kind: i % 12 === 11 ? 'model' : ['assistant', 'tool', 'result'][i % 3],
            summary: i % 12 === 11 ? `调用 #${Math.floor(i / 12) + 1} 已完成` : ['分析已有代码及执行计划', 'exec_command · npm run test', '12 tests passed'][i % 3],
            timestamp: '2026-11-09T01:00:00Z', sourceType: 'response_item.function_call', callId: `call-${Math.floor(i / 3)}`, status: null,
          })),
        };
        window.qaRuntime = runtime;
        window.qaCommands = [];
        window.qaEmit = (name, payload) => listeners.get(name)?.({ event: name, payload });
        window.__TAURI_INTERNALS__ = {
          transformCallback: callback => { callbacks.set(++serial, callback); return serial; },
          invoke: async (command, args) => {
            if (command === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)); return ++serial; }
            window.qaCommands.push({ command, args });
            if (command === 'get_tray_appearance') return { acrylic: false, dark: matchMedia('(prefers-color-scheme: dark)').matches, motion: true };
            if (command === 'get_tray_snapshot' || command === 'refresh_tray_quota') return snapshot;
            if (command === 'get_runtime_snapshot') return structuredClone(runtime);
            if (command === 'select_runtime_session') { runtime.automatic = args.id === null; runtime.revision++; return structuredClone(runtime); }
            if (command === 'get_runtime_event') return {
              event: runtime.events.find(e => e.id === args.id),
              detail: { content: '<img src=x onerror="window.qaXss=true">\n' + '长内容'.repeat(200), byteOffset: 123,
                raw: { type: 'response_item', payload: { type: 'function_call', arguments: '{"cmd":"npm run test"}', name: 'exec_command' } } },
              related: [],
            };
            if (command === 'set_tray_expanded') window.qaEmit('tray-expanded', args.expanded);
          },
        };
      }, {
        quota: { available: scenario.available, fiveHour: scenario.five === null ? null : quotaWindow(scenario.five), weekly: scenario.week === null ? null : quotaWindow(scenario.week), message: null },
        phase: scenario.phase, stale: !!scenario.stale, updatedAt: Date.now() / 1000,
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/tray.html`);
      await page.waitForFunction(() => window.qaCommands.some(c => c.command === 'get_tray_snapshot'));
      assert.equal(await page.locator('#compact').count(), 0, 'no persistent floating badge');
      assert.equal(await page.locator('#quota-rings').count(), 0, 'rings belong only to the native tray icon');
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal((await page.locator('#feedback').textContent()).includes('上次成功数据'), !!scenario.stale);
      await page.locator('#details').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.quota-row').count(), scenario.count);
      assert.equal(await page.locator('#restore').count(), 0, 'capsule action belongs in tray menu, not sidebar');
      assert.equal(await page.locator('#runtime-session option').first().textContent(), '自动 · 优化 Wisland Runtime 侧栏');
      assert.ok(await page.evaluate(() => {
        const boxes = ['refresh', 'settings', 'hide-sidebar'].map(id => document.getElementById(id).getBoundingClientRect());
        return boxes.every(b => b.width === 28 && b.height === 28 && b.y === boxes[0].y) && boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x;
      }), 'header icons share geometry and appear in the requested order');
      await page.waitForFunction(() => document.querySelectorAll('.event-row').length === 72);
      assert.equal(await page.locator('.turn-group, .step-group, .group-toggle').count(), 0, 'timeline must not contain nested groups');
      assert.deepEqual(await page.locator('.timeline-turn').allTextContents(), ['第1轮', '第2轮']);
      assert.equal(await page.locator('.timeline-gutter').first().evaluate(e => e.getBoundingClientRect().width), 34, 'turn gutter is narrower');
      assert.equal(await page.locator('.request-marker').count(), 6, 'explicit model calls have timeline markers');
      assert.ok(await page.locator('.event-summary').evaluateAll(items => items.every(item => item.getBoundingClientRect().x === items[0].getBoundingClientRect().x)), 'all event summaries align on one axis');
      assert.deepEqual(await page.locator('.event-row').evaluateAll(items => items.map(item => item.dataset.event)), Array.from({ length: 72 }, (_, i) => String(i)), 'timeline keeps source order');
      assert.equal(await page.locator('.event-row').first().evaluate(e => e.getBoundingClientRect().height), 24);
      await page.locator('#trajectory-list').evaluate(e => e.scrollTop = 170);
      await page.waitForTimeout(30);
      const beforeInspector = await page.locator('#trajectory-list').evaluate(e => e.scrollTop);
      await page.evaluate(() => {
        window.qaOriginalRow = document.querySelector('.event-row[data-event="10"]');
        window.qaOriginalKind = window.qaOriginalRow.querySelector('.event-kind');
        const rect = window.qaOriginalKind.getBoundingClientRect();
        window.qaPrefixGeometry = { x: rect.x, y: rect.y };
      });
      await page.locator('.event-row').filter({ hasText: 'exec_command' }).nth(2).dispatchEvent('click');
      await page.locator('#inspector:not([hidden])').waitFor();
      await page.waitForFunction(() => document.getElementById('inspector-content').textContent.includes('npm run test'));
      assert.equal(await page.locator('#inspector-content img').count(), 0, 'log payload must render as text, never HTML');
      await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open');
      assert.equal(await page.locator('#event-rail, .rail-event').count(), 0, 'Inspector must not build a replacement navigation rail');
      assert.ok(await page.evaluate(() => {
        const kind = document.querySelector('.event-row[data-event="10"] .event-kind');
        const rect = kind.getBoundingClientRect();
        const pane = document.getElementById('inspector').getBoundingClientRect();
        const summary = document.querySelector('.event-summary').getBoundingClientRect();
        return kind === window.qaOriginalKind && kind.parentElement === window.qaOriginalRow
          && rect.x === window.qaPrefixGeometry.x && rect.y === window.qaPrefixGeometry.y
          && Math.abs(pane.left - summary.left) < 1
          && getComputedStyle(document.getElementById('trajectory-list')).opacity === '1'
          && !document.getElementById('trajectory-list').inert;
      }), 'the same timeline column remains stationary, bright and clickable; Inspector covers only summaries');
      await page.locator('#tab-raw').click();
      assert.ok((await page.locator('#inspector-content').textContent()).includes('function_call'));
      await page.locator('#trajectory-list').evaluate(e => e.scrollTop += 48);
      await page.evaluate(() => { window.qaRuntime.revision++; window.qaEmit('runtime-snapshot', structuredClone(window.qaRuntime)); });
      assert.equal(await page.locator('#trajectory-list').evaluate(e => e.scrollTop), beforeInspector + 48, 'snapshot updates preserve left-column navigation scroll');
      await page.locator('.event-row[data-event="10"] .event-kind').click();
      await page.waitForFunction(() => document.querySelector('.event-row[data-event="10"]').getAttribute('aria-current') === 'true');
      await page.keyboard.press('Escape');
      await page.locator('#inspector').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#inspector').isVisible(), false, 'first Escape closes Inspector only');
      await page.waitForTimeout(40);
      assert.equal(await page.locator('#trajectory-list').evaluate(e => e.scrollTop), beforeInspector, 'closing Inspector restores exact list position');
      assert.equal(await page.locator('#trajectory-list').evaluate(e => e.inert), false);
      if (scale === 1 && theme === 'dark' && scenario.name === 'dual') {
        const motion = await page.evaluate(() => {
          const pane = document.getElementById('inspector');
          const card = pane.querySelector('.inspector-card');
          const row = document.querySelectorAll('.event-row')[7];
          const prefix = row.querySelector('.event-kind');
          const before = prefix.getBoundingClientRect();
          row.click();
          const slide = pane.getAnimations()[0];
          const fade = card.getAnimations()[0];
          slide.pause(); slide.currentTime = 100;
          fade.pause(); fade.currentTime = 100;
          const x = new DOMMatrixReadOnly(getComputedStyle(pane).transform).m41;
          const opacity = Number(getComputedStyle(card).opacity);
          const during = prefix.getBoundingClientRect();
          const stationary = before.x === during.x && before.y === during.y
            && getComputedStyle(document.getElementById('trajectory-list')).opacity === '1';
          document.getElementById('close-inspector').click();
          const reverseX = new DOMMatrixReadOnly(getComputedStyle(pane).transform).m41;
          row.click(); // Reopen before the closing callback can hide the overlay.
          return { x, opacity, reverseX, stationary };
        });
        assert.ok(motion.x > 0 && motion.x < 525, 'Inspector traverses intermediate positions');
        assert.ok(motion.opacity > 0 && motion.opacity < 1, 'Inspector contents fade progressively');
        assert.ok(motion.stationary, 'left timeline column does not slide or dim during the animation');
        assert.ok(Math.abs(motion.reverseX - motion.x) < 2, 'reversal starts from the current position without jumping');
        await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open');
        await page.waitForTimeout(220);
        assert.equal(await page.locator('#inspector').isVisible(), true, 'stale close callbacks cannot hide a reopened Inspector');
        await page.keyboard.press('Escape');
        await page.locator('#inspector').waitFor({ state: 'hidden' });
        await page.locator('#trajectory-list').evaluate(e => { e.scrollTop = 0; e.focus(); });
        await page.screenshot({ path: path.join(output, 'runtime-sidebar.png'), omitBackground: true });
        await page.locator('.event-row').nth(7).dispatchEvent('click');
        await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open');
        await page.locator('#tab-overview').click();
        await page.waitForTimeout(50);
        await page.screenshot({ path: path.join(output, 'runtime-inspector.png'), omitBackground: true });
        await page.keyboard.press('Escape');
        await page.locator('#inspector').waitFor({ state: 'hidden' });
        await page.locator('#follow').click();
        await page.evaluate(() => {
          const runtime = window.qaRuntime;
          runtime.events.push({ ...runtime.events.at(-1), id: '72', kind: 'assistant', summary: '实时追加事件', modelCall: null });
          runtime.revision++;
          window.qaEmit('runtime-snapshot', structuredClone(runtime));
        });
        await page.waitForFunction(() => document.querySelectorAll('.event-row').length === 73);
        assert.ok(await page.locator('#trajectory-list').evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight < 2), 'live mode follows appended events');
        await page.locator('#trajectory-list').evaluate(e => e.scrollTop = 100);
        await page.waitForTimeout(40);
        await page.evaluate(() => {
          const runtime = window.qaRuntime;
          runtime.events.push({ ...runtime.events.at(-1), id: '73', summary: '暂停时追加事件' });
          runtime.revision++;
          window.qaEmit('runtime-snapshot', structuredClone(runtime));
        });
        await page.waitForTimeout(40);
        assert.equal(await page.locator('#trajectory-list').evaluate(e => e.scrollTop), 100, 'paused reader keeps position on append');
      }
      assert.equal(await page.locator('#quota-rings').isVisible(), false, 'expanded panel must not repeat the rings');
      assert.ok(await page.evaluate(() => {
        const details = document.getElementById('details');
        const footer = document.querySelector('footer').getBoundingClientRect();
        return details.scrollHeight <= details.clientHeight && footer.bottom <= innerHeight;
      }), 'content must fit without clipping or scrolling');
      if (scale === 1.25 && theme === 'dark') await page.screenshot({ path: path.join(output, `${scenario.name}-details.png`), omitBackground: true });
      await page.locator('#settings').click();
      await page.locator('#refresh').click();
      await page.locator('#hide-sidebar').click();
      assert.ok(await page.evaluate(() => ['open_settings', 'refresh_tray_quota', 'set_tray_expanded'].every(command => window.qaCommands.some(c => c.command === command))));
      await page.keyboard.press('Escape');
      assert.ok(await page.evaluate(() => window.qaCommands.some(c => c.command === 'set_tray_expanded' && c.args.expanded === false)), 'Escape must ask Rust to hide the window');
      // A later data update must not reopen a dismissed popup.
      const showCommands = await page.evaluate(() => window.qaCommands.filter(c => c.command === 'set_tray_expanded' && c.args.expanded).length);
      await page.evaluate(() => window.qaEmit('tray-snapshot', { quota: { available: true, weekly: { remainingPercent: 80, resetsAt: null }, fiveHour: null, message: null }, phase: 'idle', stale: false, updatedAt: null }));
      assert.equal(await page.locator('.quota-row').count(), 1);
      assert.equal(await page.evaluate(() => window.qaCommands.filter(c => c.command === 'set_tray_expanded' && c.args.expanded).length), showCommands);
      await page.evaluate(() => window.qaEmit('tray-appearance', { acrylic: true, dark: true, motion: true }));
      assert.equal(await page.locator('#details').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'native glass must not be covered by opaque CSS');
      await page.evaluate(() => window.qaEmit('tray-transition', { open: true, motion: true }));
      assert.equal(await page.locator('#details').evaluate(el => el.getAnimations().length), 0, 'native window owns the slide; content must not animate separately');
      assert.equal(await page.locator('#details').evaluate(el => getComputedStyle(el).opacity), '1');
      assert.equal(await page.locator('#details').evaluate(el => getComputedStyle(el).transform), 'none');
      await page.evaluate(() => window.qaEmit('tray-appearance', { acrylic: false, dark: false, motion: false }));
      assert.equal(await page.locator('#details').evaluate(el => el.getAnimations().length), 0, 'disabled motion must not introduce a web animation');
      assert.notEqual(await page.locator('#details').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'opaque fallback must remain readable');
      assert.ok(await page.locator('.event-kind').evaluateAll(labels => labels.every(label => [...label.textContent].length === 2)), 'each type label remains two characters');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('.event-row').first().dispatchEvent('click');
      await page.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open');
      assert.equal(await page.locator('#inspector').evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'reduced motion skips Inspector animation');
      await page.keyboard.press('Escape');
      await page.locator('#inspector').waitFor({ state: 'hidden' });
      await page.evaluate(() => window.qaEmit('tray-transition', { open: true, motion: true }));
      assert.equal(await page.locator('#details').evaluate(el => el.getAnimations().length), 0, 'respect OS/browser reduced motion');
      assert.deepEqual(errors, []);
      passed++;
      await context.close();
    }
    console.log(`PASS: ${passed} sidebar UI scenarios (6 quota states × 2 themes × 3 DPI scales), stationary original timeline / summary-only drawer / narrow gutter / reversible motion / raw / safe text / scroll restoration. Screenshots: ${output}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
