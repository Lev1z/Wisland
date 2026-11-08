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
      const context = await browser.newContext({ viewport: { width: 344, height: 144 + Math.max(1, scenario.count) * 80 }, deviceScaleFactor: scale, colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.addInitScript((snapshot) => {
        const callbacks = new Map();
        const listeners = new Map();
        let serial = 0;
        window.qaCommands = [];
        window.qaEmit = (name, payload) => listeners.get(name)?.({ event: name, payload });
        window.__TAURI_INTERNALS__ = {
          transformCallback: callback => { callbacks.set(++serial, callback); return serial; },
          invoke: async (command, args) => {
            if (command === 'plugin:event|listen') { listeners.set(args.event, callbacks.get(args.handler)); return ++serial; }
            window.qaCommands.push({ command, args });
            if (command === 'get_tray_appearance') return { acrylic: false, dark: matchMedia('(prefers-color-scheme: dark)').matches, motion: true };
            if (command === 'get_tray_snapshot' || command === 'refresh_tray_quota') return snapshot;
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
      assert.equal(await page.locator('#quota-rings').isVisible(), false, 'expanded panel must not repeat the rings');
      assert.ok(await page.evaluate(() => {
        const details = document.getElementById('details');
        const footer = document.querySelector('footer').getBoundingClientRect();
        return details.scrollHeight <= details.clientHeight && footer.bottom <= innerHeight;
      }), 'content must fit without clipping or scrolling');
      if (scale === 1.25 && theme === 'dark') await page.screenshot({ path: path.join(output, `${scenario.name}-details.png`), omitBackground: true });
      await page.locator('#settings').click();
      await page.locator('#refresh').click();
      await page.locator('#restore').click();
      assert.ok(await page.evaluate(() => ['open_settings', 'refresh_tray_quota', 'set_display_mode'].every(command => window.qaCommands.some(c => c.command === command))));
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
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => window.qaEmit('tray-transition', { open: true, motion: true }));
      assert.equal(await page.locator('#details').evaluate(el => el.getAnimations().length), 0, 'respect OS/browser reduced motion');
      assert.deepEqual(errors, []);
      passed++;
      await context.close();
    }
    console.log(`PASS: ${passed} tray UI scenarios (6 states × 2 themes × 3 DPI scales). Screenshots: ${output}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
