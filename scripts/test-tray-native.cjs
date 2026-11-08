// Windows/WebView2 smoke test for this repository's own debug binary.
// npm run tauri build -- --debug --no-bundle
// node scripts/test-tray-native.cjs [--hold]
// Does not change saved preferences; the temporary DevTools endpoint is loopback-only.
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(path.resolve(__dirname, '../src-tauri/target/debug/wisland.exe'), [], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: path.resolve(__dirname, '..'),
    env: { ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: path.resolve(__dirname, '../target/tray-native-qa-profile'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  child.stderr.on('data', data => process.stderr.write(data));
  let browser;
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 'WebView2 endpoint');
    const endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    const pages = () => browser.contexts().flatMap(context => context.pages());
    const main = await until(() => pages().find(page => /tauri\.localhost\/(?:index.html)?$/.test(page.url())), 'main page');
    const popup = await until(() => pages().find(page => page.url().endsWith('/tray.html')), 'tray page');
    await popup.waitForFunction(() => document.documentElement.dataset.acrylic !== undefined);
    const invoke = (command, args) => main.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
    assert.equal(await main.evaluate(() => window.__TAURI__.app.getVersion()), require('../package.json').version, 'installed runtime version must match the build metadata');
    const visible = () => popup.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible());
    const sample = () => popup.evaluate(async () => {
      const window = globalThis.__TAURI__.window.getCurrentWindow();
      const [visible, position, size, inner, decorated, scale] = await Promise.all([
        window.isVisible(), window.outerPosition(), window.outerSize(), window.innerSize(), window.isDecorated(), window.scaleFactor(),
      ]);
      return { visible, x: position.x, y: position.y, width: size.width, height: size.height, innerWidth: inner.width, innerHeight: inner.height, decorated, scale, rows: document.querySelectorAll('.quota-row').length };
    });
    async function recordTransition(open) {
      const frames = [];
      const started = Date.now();
      const recording = (async () => {
        while (Date.now() - started < 650) {
          frames.push(await sample());
          await pause(8);
        }
      })();
      await invoke('set_tray_expanded', { expanded: open });
      await recording;
      return frames.filter(frame => frame.visible);
    }
    function assertSlide(frames, open, motion) {
      // WS_VISIBLE includes the cloaked warm-up surface. Begin motion assertions
      // at its lowest position, after the hidden full-size surface is prepared.
      if (open && motion && frames.length) {
        const lowest = Math.max(...frames.map(frame => frame.y));
        frames = frames.slice(frames.findIndex(frame => frame.y === lowest));
      }
      assert.ok(frames.length > 0, 'capture visible animation frames');
      assert.ok(frames.every(frame => !frame.decorated), 'never enable native decorations during animation');
      assert.ok(frames.every(frame => frame.x === frames[0].x), 'movement must be vertical');
      assert.ok(frames.every(frame => frame.width === frames[0].width), 'viewport width must remain stable');
      // Live quota data can remove a row when an account has no 5h limit. Measure
      // the bottom edge so that this legitimate resize is not mistaken for drift.
      const bottom = frame => frame.y + frame.height;
      for (let i = 1; i < frames.length; i++) {
        const removedRow = Math.abs(frames[i].y - frames[i - 1].y - 80 * frames[i].scale) <= 1 && Math.abs(frames[i].height - frames[i - 1].height + 80 * frames[i].scale) <= 1;
        // Height changes are now intentional: the native viewport is the clip.
        // A live quota row-count change can also relocate the final resting panel.
        assert.ok(open ? frames[i].y <= frames[i - 1].y || frames[i].rows !== frames[i - 1].rows || removedRow : frames[i].y >= frames[i - 1].y,
          `slide must move ${open ? 'up' : 'down'}: ${JSON.stringify(frames.map(frame => frame.y))}`);
      }
      if (motion) assert.ok(new Set(frames.map(frame => frame.y)).size > 1, 'native surface must actually move');
      console.log(`${open ? 'Upward entrance' : 'Downward exit'} Y samples:`, frames.map(frame => frame.y).join(', '));
    }
    function assertRest(actual, expected, message) {
      assert.deepEqual(
        { x: actual.x, bottom: actual.y + actual.height, width: actual.width, visible: actual.visible, decorated: actual.decorated },
        { x: expected.x, bottom: expected.y + expected.height, width: expected.width, visible: expected.visible, decorated: expected.decorated }, message);
    }
    await invoke('set_display_mode', { mode: 'tray' });
    assert.equal(await visible(), false, 'tray mode must not show a persistent window');
    // Stabilize the first account response before testing motion geometry. A
    // weekly-only account legitimately removes the initial placeholder 5h row.
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await invoke('get_tray_snapshot')).quota.available) break;
      await pause(100);
    }
    await pause(200);
    await invoke('set_tray_expanded', { expanded: true });
    await until(visible, 'open animation');
    await pause(300);
    const appearance = await invoke('get_tray_appearance');
    console.log('Native tray appearance:', JSON.stringify(appearance), 'test process:', child.pid);
    assert.equal(await popup.locator('html').getAttribute('data-acrylic'), String(appearance.acrylic));
    assert.equal(await popup.locator('html').getAttribute('data-theme'), appearance.dark ? 'dark' : 'light');
    if (appearance.acrylic) assert.equal(await popup.locator('#details').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    // Let initial quota loading settle before measuring fixed-size animation frames.
    await pause(500);
    assertSlide(await recordTransition(false), false, appearance.motion);
    await until(async () => !(await visible()), 'close animation');
    assertSlide(await recordTransition(true), true, appearance.motion);
    await until(visible, 'upward entrance');
    const rest = await sample();
    await invoke('set_tray_expanded', { expanded: true });
    await pause(300);
    assertRest(await sample(), rest, 'clicking an open popup must not replay or drift its position');
    // Queue close/reopen without waiting for the previous animation.
    await Promise.all([
      invoke('set_tray_expanded', { expanded: true }),
      invoke('set_tray_expanded', { expanded: false }),
    ]);
    await invoke('set_tray_expanded', { expanded: true });
    await until(visible, 'reopen after rapid input');
    await pause(550);
    assert.equal(await visible(), true, 'stale close callbacks must not hide the reopened popup');
    // Reverse a close that is already in progress, not just pending in the event queue.
    await invoke('set_tray_expanded', { expanded: false });
    await pause(60);
    await invoke('set_tray_expanded', { expanded: true });
    await pause(550);
    assert.equal(await visible(), true, 'in-flight close must be cancelable');
    assertRest(await sample(), rest, 'reopening restores the exact resting position');
    // Mode changes must cancel every queued frame and never show the old panel again.
    await invoke('set_tray_expanded', { expanded: false });
    await pause(40);
    await invoke('set_display_mode', { mode: 'capsule' });
    await until(async () => !(await visible()), 'restore capsule');
    await pause(350);
    assert.equal(await visible(), false, 'a stale animation must not undo restoring capsule mode');
    assert.equal(popup.isClosed(), false, 'dismissal must hide, not destroy, the initialized WebView');
    assert.equal(pages().filter(page => page.url().endsWith('/tray.html')).length, 1, 'reuse exactly one tray WebView across every transition');
    console.log('PASS: native slide direction / stable borderless frame / repeated open / rapid reopen / restore capsule');
    if (process.argv.includes('--hold')) {
      await invoke('set_display_mode', { mode: 'tray' });
      await invoke('set_tray_expanded', { expanded: true });
      await pause(750);
      assert.equal(await visible(), true, 'the final popup must remain visible after animation events settle');
      console.log('Holding the test popup for visual inspection; enter "open" to reopen it. Ctrl+C closes only this test process.');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', text => {
        if (text.trim() === 'open') void invoke('set_tray_expanded', { expanded: true });
      });
      process.stdin.resume();
      await new Promise(resolve => process.once('SIGINT', resolve));
      process.stdin.pause();
    }
  } finally {
    child.kill();
    if (browser) await browser.close().catch(() => {});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
