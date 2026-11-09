// Windows/WebView2 smoke test for this repository's own binary.
// npm run tauri build -- --debug --no-bundle
// node scripts/test-tray-native.cjs [--hold] [--release]
// Does not change saved preferences; the temporary DevTools endpoint is loopback-only.
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');

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
  let runtimeHome;
  let runtimeFile;
  const runtimeThreadId = '019a6b3c-1234-5678-9abc-0123456789ab';
  const record = (type, payload) => JSON.stringify({ timestamp: '2026-11-09T00:00:00Z', type, payload }) + '\n';
  if (process.argv.includes('--runtime')) {
    runtimeHome = path.resolve(__dirname, `../target/runtime-native-qa-${Date.now()}`);
    await fs.mkdir(path.join(runtimeHome, 'sessions'), { recursive: true });
    runtimeFile = path.join(runtimeHome, `sessions/rollout-2026-11-09T12-30-00-${runtimeThreadId}.jsonl`);
    await fs.writeFile(path.join(runtimeHome, 'session_index.jsonl'), JSON.stringify({ id: runtimeThreadId, thread_name: 'Runtime 侧栏回归会话' }) + '\n');
    await fs.writeFile(runtimeFile, record('session_meta', { id: runtimeThreadId, history_mode: 'paginated', history_base: null })
      + record('event_msg', { type: 'task_started', turn_id: 'qa-turn' })
      + record('event_msg', { type: 'user_message', message: '测试中文增量轨迹' })
      + record('response_item', { type: 'function_call', name: 'exec_command', call_id: 'qa-call', arguments: '{"cmd":"npm test"}' }));
  }
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const profile = process.argv.includes('--release') ? 'release' : 'debug';
  const child = spawn(path.resolve(__dirname, `../src-tauri/target/${profile}/wisland.exe`), [], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: path.resolve(__dirname, '..'),
    env: { ...process.env,
      ...(runtimeHome ? { CODEX_HOME: runtimeHome } : {}),
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
    if (process.argv.includes('--display')) {
      await invoke('set_display_mode', { mode: 'capsule' });
      await invoke('start_drag');
      await main.evaluate(async () => {
        const appWindow = window.__TAURI__.window.getCurrentWindow();
        const position = await appWindow.outerPosition();
        await appWindow.setPosition(new window.__TAURI__.dpi.PhysicalPosition(position.x + 100, position.y + 150));
      });
      await invoke('end_drag');
      await pause(700);
      async function assertCentered(label) {
        const geometry = await main.evaluate(async () => {
          const appWindow = window.__TAURI__.window.getCurrentWindow();
          return { position: await appWindow.outerPosition(), size: await appWindow.outerSize(), monitor: await window.__TAURI__.window.currentMonitor() };
        });
        const { position, size, monitor } = geometry;
        assert.ok(Math.abs(position.x + size.width / 2 - (monitor.position.x + monitor.size.width / 2)) <= 2, `${label}: horizontal center`);
        assert.ok(Math.abs(position.y - monitor.position.y) <= 2, `${label}: monitor top`);
      }
      await assertCentered('drag return');
      await invoke('set_minimized', { minimized: true });
      await pause(500);
      await assertCentered('minimized bar');
      await invoke('set_minimized', { minimized: false });
      await pause(500);
      await assertCentered('restored capsule');
      console.log('PASS: native capsule drag return / minimized / restored positioning');
    }
    const visible = () => popup.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible());
    const sample = () => popup.evaluate(async () => {
      const window = globalThis.__TAURI__.window.getCurrentWindow();
      const [visible, inner, decorated, scale] = await Promise.all([
        window.isVisible(), window.innerSize(), window.isDecorated(), window.scaleFactor(),
      ]);
      const [x, y, width, height] = await globalThis.__TAURI__.core.invoke('get_tray_geometry');
      return { visible, x, y, width, height, innerWidth: inner.width, innerHeight: inner.height, decorated, scale, rows: document.querySelectorAll('.quota-row').length };
    });
    async function recordTransition(open) {
      const frames = [await sample()];
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
      // WS_VISIBLE also includes the cloaked first-frame composition.
      if (open && motion && frames.length) {
        const rightmost = Math.max(...frames.map(frame => frame.x));
        frames = frames.slice(frames.findIndex(frame => frame.x === rightmost));
      }
      assert.ok(frames.length > 0, 'capture native animation frames');
      assert.ok(frames.every(f => !f.decorated), 'no native title bar');
      assert.ok(frames.every(f => f.y === frames[0].y), 'movement must be horizontal');
      assert.ok(frames.every(f => f.height === frames[0].height), 'full work-area height remains fixed');
      const right = frames[0].x + frames[0].width;
      assert.ok(frames.every(f => f.x + f.width === right), `screen right edge is a fixed clipping boundary: ${JSON.stringify(frames)}`);
      for (let i = 1; i < frames.length; i++) {
        assert.ok(open ? frames[i].x <= frames[i - 1].x : frames[i].x >= frames[i - 1].x,
          'slide must move continuously towards its endpoint');
      }
      if (motion) assert.ok(new Set(frames.map(f => f.x)).size > 1, 'native surface must actually move');
      console.log(open ? 'Leftward entrance X:' : 'Rightward exit X:', frames.map(f => f.x).join(', '));
    }
    function assertRest(actual, expected, message) {
      assert.deepEqual(
        { x: actual.x, bottom: actual.y + actual.height, width: actual.width, visible: actual.visible, decorated: actual.decorated },
        { x: expected.x, bottom: expected.y + expected.height, width: expected.width, visible: expected.visible, decorated: expected.decorated }, message);
    }
    await invoke('set_display_mode', { mode: 'tray' });
    assert.equal(await visible(), false, 'tray mode must not show a persistent window');
    if (runtimeHome) {
      const initial = await until(async () => { const value = await invoke('get_runtime_snapshot'); return value.events.length === 4 && value; }, 'initial runtime fixture');
      const pendingHeader = initial.events.find(e => e.kind === 'model');
      assert.equal(pendingHeader.status, 'awaiting_association');
      assert.equal(pendingHeader.modelCall, null);
      assert.equal(initial.sessions[0].label, 'Runtime 侧栏回归会话', 'rollout UUID maps to Codex title');
      await fs.appendFile(path.join(runtimeHome, 'session_index.jsonl'), JSON.stringify({ id: runtimeThreadId, thread_name: '会话重命名验证' }) + '\n');
      await until(async () => (await invoke('get_runtime_snapshot')).sessions[0].label === '会话重命名验证', 'rename synchronization');
      await popup.waitForFunction(() => document.querySelector('#runtime-session-label').textContent.includes('会话重命名验证'));
      const line = Buffer.from(record('response_item', { type: 'function_call_output', call_id: 'qa-call', output: '中文执行结果' }));
      const split = line.indexOf(Buffer.from('中')) + 1; // split inside a UTF-8 character
      await fs.appendFile(runtimeFile, line.subarray(0, split));
      await pause(700);
      assert.equal((await invoke('get_runtime_snapshot')).events.length, 4, 'an incomplete UTF-8 line must not be parsed');
      await fs.appendFile(runtimeFile, line.subarray(split));
      const appended = await until(async () => { const value = await invoke('get_runtime_snapshot'); return value.events.length === 5 && value; }, 'incremental append');
      assert.equal(appended.events[4].summary, '中文执行结果');
      assert.equal(appended.events[3].turnId, appended.events[4].turnId);
      await popup.waitForFunction(() => document.querySelectorAll('.event-row').length === 5);
      const inspected = await invoke('get_runtime_event', { sessionId: appended.sessionId, id: appended.events[3].id });
      assert.equal(inspected.related[0].detail.content, '中文执行结果');
      await invoke('set_tray_expanded', { expanded: true });
      await until(visible, 'Inspector native host');
      await pause(350);
      await popup.locator('.event-row[data-kind="tool"]').click();
      await popup.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open'
        && document.getElementById('inspector-content').textContent.includes('中文执行结果'));
      assert.equal(await popup.locator('#inspector-title').textContent(), '执行命令');
      assert.equal(await popup.locator('[data-section="command"] pre').textContent(), 'npm test');
      assert.equal((await popup.locator('#inspector-content').textContent()).split('中文执行结果').length - 1, 1);
      assert.equal(await popup.locator('[data-section="technical"]').getAttribute('open'), null);
      await popup.locator('#tab-raw').click();
      assert.ok((await popup.locator('#inspector-content').textContent()).includes('function_call'));
      assert.equal(await popup.locator('[data-section="raw"]').getAttribute('data-expanded'), 'true', 'native raw tab starts fully expanded');
      await popup.locator('#tab-overview').click();
      await popup.keyboard.press('Escape');
      await popup.locator('#inspector').waitFor({ state: 'hidden' });
      await invoke('set_tray_expanded', { expanded: false });
      await until(async () => !(await visible()), 'Inspector native host hidden');
      console.log('PASS: native Inspector command / related output / deduplication / raw tab / close');
      await fs.appendFile(runtimeFile, record('token_usage_record', { turn_id: 'qa-turn', response_id: 'qa-response', usage: { total_tokens: 42 } }));
      const accounted = await until(async () => { const value = await invoke('get_runtime_snapshot'); return value.events.some(e => e.status === 'usage_recorded') && value; }, 'model usage without completion');
      assert.equal(accounted.events[2].id, pendingHeader.id, 'pending heading is promoted in place before its tool');
      assert.equal(accounted.events[2].status, 'usage_recorded');
      assert.equal(accounted.events[2].modelPresentation.association, 'sequence');
      await fs.appendFile(runtimeFile, record('event_msg', { type: 'raw_response_completed', response_id: 'qa-response', token_usage: { total_tokens: 42 } }));
      const completion = await until(async () => { const value = await invoke('get_runtime_snapshot'); return value.events.some(e => e.status === 'response_completed') && value; }, 'explicit model completion');
      assert.equal(completion.events.length, 5);
      assert.equal(completion.events[2].modelCall.responseId, 'qa-response');
      assert.equal(completion.events[2].modelCall.number, 1, 'completion mirrors represent one model call');
      const modelDetail = await invoke('get_runtime_event', { sessionId: completion.sessionId, id: pendingHeader.id });
      assert.equal(modelDetail.detail.raw.payload.response_id, 'qa-response');
      assert.equal(modelDetail.related.length, 2, 'associated tool and output are readable without moving the output');
      await popup.waitForFunction(() => document.querySelectorAll('.request-marker').length === 1);
      assert.equal(await popup.locator('.turn-group, .step-group').count(), 0, 'native view uses a flat timeline');
      await assert.rejects(invoke('select_runtime_session', { id: '../../auth.json' }), /会话不在/);
      await invoke('select_runtime_session', { id: initial.sessionId });
      // A replacement rollout for the same thread is NOT a second conversation.
      const replacementId = '019a6b3c-1234-5678-9abc-0123456789ac';
      const cutoff = (await fs.stat(runtimeFile)).size;
      const replacement = path.join(runtimeHome, `sessions/rollout-2026-11-09T12-31-00-${runtimeThreadId}_${replacementId}.jsonl`);
      await fs.writeFile(replacement, record('session_meta', { id: runtimeThreadId, history_mode: 'paginated', history_base: { thread_id: runtimeThreadId, end_ordinal_exclusive: 100, end_byte_offset: cutoff } })
        + record('event_msg', { type: 'agent_message', message: 'replacement continuation' }));
      // The quota CLI can backfill an index in this test's isolated CODEX_HOME.
      // A real revert changes BOTH the file and threads.rollout_path atomically.
      const fixtureDbPath = path.join(runtimeHome, 'state_5.sqlite');
      if (await fs.stat(fixtureDbPath).then(() => true, () => false)) {
        const db = new DatabaseSync(fixtureDbPath);
        try { db.exec('PRAGMA busy_timeout=2000'); db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(replacement, runtimeThreadId); }
        finally { db.close(); }
      }
      await until(async () => { const value = await invoke('get_runtime_snapshot'); return value.sessions.length === 1 && value.sessions[0].rolloutCount === 2 && value.events.length === 6; }, 'same-thread generations merged with retained history');
      await fs.appendFile(runtimeFile, record('event_msg', { type: 'agent_message', message: 'abandoned suffix must not appear' }));
      await pause(3500);
      const retained = await invoke('get_runtime_snapshot');
      assert.equal(retained.sessionId, initial.sessionId); assert.equal(retained.events.length, 6);
      assert.ok(!retained.events.some(e => e.summary.includes('abandoned')));
      const forkId = '019a6b3c-1234-5678-9abc-0123456789ad';
      const second = path.join(runtimeHome, `sessions/rollout-2026-11-09T12-32-00-${forkId}.jsonl`);
      await fs.writeFile(second, record('session_meta', { id: forkId, forked_from_id: runtimeThreadId, history_mode: 'paginated', history_base: null })
        + record('event_msg', { type: 'task_started', turn_id: 'qa-second' }));
      await fs.appendFile(path.join(runtimeHome, 'session_index.jsonl'), JSON.stringify({ id: forkId, thread_name: '会话重命名验证' }) + '\n');
      await until(async () => (await invoke('get_runtime_snapshot')).sessions.length === 2, 'new session discovery');
      assert.equal((await invoke('get_runtime_snapshot')).sessionId, initial.sessionId, 'pinned session must not switch');
      assert.notEqual((await invoke('select_runtime_session', { id: null })).sessionId, initial.sessionId, 'auto mode chooses latest active log');
      console.log('PASS: native JSONL append / split UTF-8 / results / model markers / logical thread dedup / history cutoffs / distinct forks / path rejection / pinned and automatic sessions');
    }
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
    // Focus can be taken by the terminal/test runner during setup. Re-open just
    // before recording; an already-visible panel is not supposed to replay motion.
    await invoke('set_tray_expanded', { expanded: true });
    await pause(350);
    assert.equal(await visible(), true, 'sidebar must be visible before recording its exit');
    assertSlide(await recordTransition(false), false, appearance.motion);
    await until(async () => !(await visible()), 'close animation');
    assertSlide(await recordTransition(true), true, appearance.motion);
    await until(visible, 'upward entrance');
    const rest = await sample();
    await popup.locator('#runtime-session').click();
    assert.ok(await popup.locator('#runtime-sessions').evaluate(panel => {
      const rect = panel.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    }), 'native WebView session picker stays inside the sidebar');
    await popup.keyboard.press('Escape');
    assert.equal(await visible(), true, 'picker Escape must not hide the native sidebar');
    const monitor = await popup.evaluate(() => window.__TAURI__.window.currentMonitor());
    assert.equal(rest.x + rest.width, monitor.workArea.position.x + monitor.workArea.size.width, 'resting outer window ends exactly at work-area right edge');
    assert.ok(rest.y >= monitor.workArea.position.y && rest.y + rest.height <= monitor.workArea.position.y + monitor.workArea.size.height, 'sidebar stays above taskbar');
    assert.ok(Math.abs(rest.innerWidth / rest.scale - 525) <= 1, 'content width stays 525 logical pixels');
    const initiallyFocused = await popup.evaluate(() => window.__TAURI__.window.getCurrentWindow().isFocused());
    await invoke('open_settings');
    const settingsPage = await until(() => pages().find(page => page.url().includes('/settings.html')), 'settings focus target');
    await settingsPage.waitForFunction(version => {
      const labels = [...document.querySelectorAll('[data-app-version]')];
      return labels.length === 2 && labels.every(label => label.textContent === version);
    }, require('../package.json').version);
    // The first call creates a WebView asynchronously; request activation only
    // after that WebView is ready, using the existing settings-window path.
    await invoke('open_settings');
    await until(() => settingsPage.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()), 'settings is visible');
    // Windows may deny foreground activation to a background test process.
    // Check the actual contract: the sidebar remains visible while unfocused,
    // regardless of whether settings or the external runner owns the foreground.
    await until(async () => !(await popup.evaluate(() => window.__TAURI__.window.getCurrentWindow().isFocused())), 'sidebar is unfocused');
    await pause(350);
    assert.equal(await visible(), true, 'an unfocused sidebar must remain visible');
    console.log(`PASS: unfocused sidebar stays visible (${initiallyFocused ? 'focus transition observed' : 'Windows kept the test process in the background'})`);
    // This command and the left-button release callback share toggle_details.
    // Do not use focus or WS_VISIBLE as the state during cloak/exit animation.
    await invoke('toggle_tray_expanded');
    await until(async () => !(await visible()), 'tray toggle closes an unfocused sidebar');
    await invoke('toggle_tray_expanded');
    await pause(550);
    assert.equal(await visible(), true, 'next tray toggle reopens the sidebar');
    assertRest(await sample(), rest, 'toggle keeps the same resting geometry');
    await Promise.all([invoke('toggle_tray_expanded'), invoke('toggle_tray_expanded')]);
    await pause(550);
    assert.equal(await visible(), true, 'two rapid toggles preserve the open target');
    await invoke('toggle_tray_expanded');
    await until(async () => !(await visible()), 'toggle closes before warmup cancellation test');
    await Promise.all([invoke('toggle_tray_expanded'), invoke('toggle_tray_expanded')]);
    await pause(550);
    assert.equal(await visible(), false, 'two rapid toggles cancel a cloaked/starting entrance');
    await invoke('toggle_tray_expanded');
    await pause(550);
    await invoke('toggle_tray_expanded');
    await pause(40);
    await invoke('toggle_tray_expanded');
    await pause(550);
    assert.equal(await visible(), true, 'toggle reverses an in-flight exit using its target state');
    assertRest(await sample(), rest, 'reversed tray toggle restores exact position');
    console.log('PASS: tray toggle open / unfocused close / rapid parity / warmup cancellation / exit reversal');
    const settingsClosed = settingsPage.waitForEvent('close');
    await settingsPage.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(error => {
      // Closing the native WebView can destroy the IPC reply context first.
      if (!settingsPage.isClosed()) throw error;
    });
    await settingsClosed;
    await invoke('set_tray_expanded', { expanded: true });
    await pause(300);
    assertRest(await sample(), rest, 'an explicit show request remains idempotent');
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
    await invoke('toggle_tray_expanded');
    await pause(350);
    assert.equal(await visible(), false, 'sidebar toggle does not change capsule mode');
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
