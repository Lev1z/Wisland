// Sequential, isolated native benchmark. Never attaches to a user's instance.
// node scripts/measure-runtime-perf.cjs <absolute-exe> [seconds-per-case=30] [hidden|sidebar|inspector]
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { chromium } = require('../target/tray-qa-tools/node_modules/playwright');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await pause(100); } throw Error('benchmark startup timeout'); }
const record = (type, payload) => JSON.stringify({ timestamp: '2026-11-10T00:00:00Z', type, payload }) + '\n';
async function sample(pid) {
  const command = `$all=@(Get-CimInstance Win32_Process); $ids=@(${pid}); do { $next=@($all|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object ProcessId); $ids+=$next } while($next.Count); $perf=@(Get-CimInstance Win32_PerfRawData_PerfProc_Process); $rows=@(foreach($p in $all|Where-Object ProcessId -In $ids) { $w=$perf|Where-Object IDProcess -EQ $p.ProcessId|Select-Object -First 1; [pscustomobject]@{id=$p.ProcessId;cpu=([double]$p.KernelModeTime+[double]$p.UserModeTime)/1e7;privateWS=[double]$w.WorkingSetPrivate;ws=[double]$p.WorkingSetSize;commit=[double]$p.PrivatePageCount;read=[double]$p.ReadTransferCount;write=[double]$p.WriteTransferCount} }); [pscustomobject]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();cores=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors;rows=$rows}|ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse((await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout);
}
async function main() {
  const binary = process.argv[2];
  assert.ok(path.isAbsolute(binary));
  const seconds = Number(process.argv[3] ?? 30);
  assert.ok(seconds >= 10 && seconds <= 60);
  const modes = process.argv[4] ? [process.argv[4]] : ['hidden', 'sidebar', 'inspector'];
  assert.ok(modes.every(m => ['hidden', 'sidebar', 'inspector'].includes(m)));
  const root = await fs.mkdtemp(path.resolve(__dirname, '../target/runtime-perf-'));
  const home = path.join(root, 'codex');
  for (const dir of ['sessions', 'archived_sessions']) await fs.mkdir(path.join(home, dir), { recursive: true });
  for (const dir of ['roaming', 'local', 'webview']) await fs.mkdir(path.join(root, dir));
  const thread = '019a6b3c-1234-5678-9abc-0123456789ab';
  const logfile = path.join(home, `sessions/rollout-2026-11-10T00-00-00-${thread}.jsonl`);
  let seed = record('session_meta', { id: thread, history_mode: 'paginated', history_base: null });
  for (let t = 0; t < 50; t++) {
    seed += record('event_msg', { type: 'task_started', turn_id: `t${t}` });
    seed += record('event_msg', { type: 'user_message', message: `Synthetic turn ${t}` });
    for (let c = 0; c < 8; c++) {
      seed += record('response_item', { type: 'function_call', name: 'exec_command', call_id: `${t}-${c}`, arguments: JSON.stringify({ cmd: 'synthetic command ' + 'x'.repeat(1024) }) });
      seed += record('response_item', { type: 'function_call_output', call_id: `${t}-${c}`, output: 'Synthetic result\n' + 'x'.repeat(2048) });
    }
    seed += record('token_usage_record', { response_id: `response-${t}`, turn_id: `t${t}`, usage: { total_tokens: 100 } });
    seed += record('event_msg', { type: 'task_complete', turn_id: `t${t}`, last_agent_message: 'Synthetic completion' });
  }
  await fs.writeFile(logfile, seed);
  // Stable catalog size in both runs; these files never contain real conversations.
  for (let i = 0; i < 35; i++) {
    const id = `019a6b3c-1234-5678-9abc-${String(i).padStart(12, '0')}`;
    await fs.writeFile(path.join(home, `sessions/rollout-2026-11-09T00-00-00-${id}.jsonl`), record('session_meta', { id }));
  }
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const child = spawn(binary, [], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env,
    CODEX_HOME: home, APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` } });
  let browser, writer;
  let writing = Promise.resolve(), serial = 0;
  const reports = [];
  try {
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } });
    browser = await chromium.connectOverCDP((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
    const pages = () => browser.contexts().flatMap(c => c.pages());
    const mainPage = await until(() => pages().find(p => /tauri\.localhost\/(?:index.html)?$/.test(p.url())));
    const panel = await until(() => pages().find(p => p.url().endsWith('/tray.html')));
    const invoke = (command, args) => mainPage.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
    await invoke('set_display_mode', { mode: 'tray' });
    await invoke('set_tray_expanded', { expanded: true });
    await until(async () => (await invoke('get_runtime_snapshot')).sessions.some(s => s.id === thread));
    await invoke('select_runtime_session', { id: thread });
    await until(async () => (await invoke('get_runtime_snapshot')).events.length > 700);
    await pause(10000); // identical warm-up, including initial quota CLI failure
    await invoke('set_tray_expanded', { expanded: false }); await pause(700);
    writer = setInterval(() => {
      const n = serial++;
      writing = writing.then(() => fs.appendFile(logfile, record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Live ${n}\n` + 'z'.repeat(2048) }] })));
    }, 500);
    for (const mode of modes) {
      if (mode !== 'hidden') { await invoke('set_tray_expanded', { expanded: true }); await pause(1500); }
      if (mode === 'inspector') {
        await panel.locator('.event-row[data-kind="tool"]').first().click();
        await panel.waitForFunction(() => document.getElementById('inspector').dataset.phase === 'open');
      }
      const before = await sample(child.pid);
      await pause(seconds * 1000);
      const after = await sample(child.pid);
      const elapsed = (after.at - before.at) / 1000;
      const common = after.rows.filter(p => before.rows.some(q => q.id === p.id));
      const stableProcessSet = common.length === before.rows.length && common.length === after.rows.length;
      if (!stableProcessSet) console.warn('Process churn: CPU/I/O deltas cover common surviving processes only; do not treat this case as a strict whole-tree comparison.');
      const delta = field => common.reduce((sum, p) => sum + p[field] - before.rows.find(q => q.id === p.id)[field], 0);
      const sum = field => after.rows.reduce((total, p) => total + p[field], 0);
      const result = { mode, seconds: elapsed, processCount: after.rows.length, stableProcessSet,
        cpuMachinePct: delta('cpu') / elapsed / after.cores * 100, cpuSeconds: delta('cpu'),
        privateWsMiB: sum('privateWS') / 1048576, wsMiB: sum('ws') / 1048576, commitMiB: sum('commit') / 1048576,
        readMiB: delta('read') / 1048576, writeMiB: delta('write') / 1048576,
        visible: await panel.evaluate(() => window.__TAURI__.window.getCurrentWindow().isVisible()),
        processes: common.map(p => ({ id: p.id, host: p.id === child.pid, cpuSeconds: p.cpu - before.rows.find(q => q.id === p.id).cpu, privateWsMiB: p.privateWS / 1048576 })) };
      reports.push(result); console.log(JSON.stringify(result));
    }
  } finally {
    clearInterval(writer); await writing;
    child.kill(); if (browser) await browser.close().catch(() => {});
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ binary, fixture: { seedBytes: Buffer.byteLength(seed), catalogFiles: 36, appendIntervalMs: 500, appendTextChars: 2048 }, reports }, null, 2));
  }
  console.log(`Report: ${path.join(root, 'report.json')}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
