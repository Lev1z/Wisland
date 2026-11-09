// Offline capability probe for an explicitly selected installed Codex binary.
// No credentials, real sessions, global environment changes or Desktop control.
// Usage: node scripts/probe-rollout-trace.cjs <absolute-codex.exe> [...]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function files(root, name) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(item, name));
    else if (entry.isFile() && entry.name === name) result.push(item);
  }
  return result;
}
async function events(root) {
  const logs = await files(root, 'trace.jsonl');
  const result = [];
  for (const log of logs) for (const line of (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean)) {
    try { result.push(JSON.parse(line)); } catch { /* incomplete trailing write */ }
  }
  return result;
}
async function payload(bundle, reference) {
  assert.equal(typeof reference?.path, 'string');
  const file = path.resolve(bundle, reference.path);
  const relative = path.relative(bundle, file);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), 'payload stays inside its fixture bundle');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
function run(binary, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-128 * 1024); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-128 * 1024); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('probe child exceeded 40 seconds')); }, 40000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
function isolatedEnvironment(root) {
  const env = {};
  const allowed = /^(systemroot|windir|comspec|path|pathext|processor_architecture|number_of_processors)$/i;
  for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
  return { ...env, USERPROFILE: path.join(root, 'profile'), HOME: path.join(root, 'profile'),
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    CODEX_HOME: path.join(root, 'codex-home'), CODEX_ROLLOUT_TRACE_ROOT: path.join(root, 'traces'),
    NO_COLOR: '1', RUST_LOG: 'warn',
  };
}
async function probeCase(binary, root, mode) {
  const env = isolatedEnvironment(root);
  for (const dir of [root, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.CODEX_HOME, env.CODEX_ROLLOUT_TRACE_ROOT]) await fs.mkdir(dir, { recursive: true });
  let requests = 0, startedBeforeCompletion = false;
  const blockedOutbound = new Set();
  const errors = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      if (/^https?:/i.test(request.url)) {
        blockedOutbound.add(new URL(request.url).hostname);
        response.writeHead(502); response.end(); return;
      }
      if (request.url !== '/v1/responses' || request.method !== 'POST') {
        response.writeHead(404); response.end(); return;
      }
      assert.equal(request.headers.authorization, undefined, 'the synthetic provider must receive no credentials');
      requests++;
      for await (const _ of request) { /* discard the synthetic request body */ }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'response.created', response: { id: `probe-${mode}` } });
      for (let attempt = 0; attempt < 40; attempt++) {
        const recorded = await events(env.CODEX_ROLLOUT_TRACE_ROOT);
        if (recorded.some(e => e.payload.type === 'inference_started')) {
          startedBeforeCompletion = !recorded.some(e => e.payload.type === 'inference_completed'); break;
        }
        await pause(50);
      }
      send({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `message-${mode}`,
        content: [{ type: 'output_text', text: 'Synthetic local trace probe.' }] } });
      if (mode === 'completed') send({ type: 'response.completed', response: { id: `probe-${mode}`,
        usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });
      // A deliberately truncated SSE stream exercises the failed-attempt path.
      response.end();
    })().catch(error => { errors.push(error.message); response.destroy(); });
  });
  server.on('connect', (request, socket) => { blockedOutbound.add(String(request.url).split(':')[0]); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(env, { HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: '127.0.0.1,localhost' });
  const overrides = [
    'model="trace-probe"', 'model_provider="trace_probe"',
    'model_providers.trace_probe.name="Wisland offline fixture"',
    `model_providers.trace_probe.base_url="${base}/v1"`,
    'model_providers.trace_probe.wire_api="responses"',
    'model_providers.trace_probe.requires_openai_auth=false',
    'model_providers.trace_probe.supports_websockets=false',
    'model_providers.trace_probe.request_max_retries=0',
    'model_providers.trace_probe.stream_max_retries=0',
    'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
    'otel.exporter="none"', 'otel.trace_exporter="none"', 'otel.metrics_exporter="none"',
    'features.memories=false', 'features.plugins=false',
  ].flatMap(value => ['-c', value]);
  let execution;
  try {
    execution = await run(binary, ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', ...overrides,
      'Synthetic offline protocol fixture. Reply with one short sentence; do not invoke tools.'], root, env);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  await fs.writeFile(path.join(root, 'execution.json'), JSON.stringify(execution, null, 2));
  assert.deepEqual(errors, []);
  assert.equal(requests, 1, `expected one local request: ${execution.stderr}`);
  assert.equal(startedBeforeCompletion, true, 'inference_started must be visible while response is still open');
  assert.equal(execution.code === 0, mode === 'completed', execution.stderr);
  const raw = await events(env.CODEX_ROLLOUT_TRACE_ROOT);
  // The inspected checkout uses v1; installed 0.167 runtimes emit v2.
  // Verify the shared envelope explicitly, and fail on unexamined versions.
  const schemaVersion = raw[0]?.schema_version;
  assert.ok([1, 2].includes(schemaVersion), `unsupported trace schema: ${schemaVersion}`);
  assert.ok(raw.every(e => e.schema_version === schemaVersion && Number.isFinite(e.wall_time_unix_ms)
    && Number.isSafeInteger(e.seq) && typeof e.rollout_id === 'string' && typeof e.payload?.type === 'string'));
  assert.ok(raw.every((e, i) => i === 0 || e.seq > raw[i - 1].seq));
  const started = raw.filter(e => e.payload.type === 'inference_started');
  const terminal = raw.filter(e => ['inference_completed', 'inference_failed', 'inference_cancelled'].includes(e.payload.type));
  assert.equal(started.length, 1); assert.equal(terminal.length, 1);
  assert.equal(terminal[0].payload.inference_call_id, started[0].payload.inference_call_id);
  assert.equal(terminal[0].thread_id, started[0].thread_id);
  assert.equal(terminal[0].codex_turn_id, started[0].codex_turn_id);
  assert.ok(terminal[0].wall_time_unix_ms >= started[0].wall_time_unix_ms);
  assert.equal(terminal[0].payload.type, mode === 'completed' ? 'inference_completed' : 'inference_failed');
  const bundles = await files(env.CODEX_ROLLOUT_TRACE_ROOT, 'manifest.json');
  assert.equal(bundles.length, 1);
  const bundle = path.dirname(bundles[0]);
  const manifest = JSON.parse(await fs.readFile(bundles[0], 'utf8'));
  assert.equal(manifest.schema_version, schemaVersion);
  await payload(bundle, started[0].payload.request_payload);
  await payload(bundle, mode === 'completed' ? terminal[0].payload.response_payload : terminal[0].payload.partial_response_payload);
  const reduction = await run(binary, ['debug', 'trace-reduce', bundle], root, env);
  await fs.writeFile(path.join(root, 'reduction.json'), JSON.stringify(reduction, null, 2));
  assert.equal(reduction.code, 0, reduction.stderr);
  const state = JSON.parse(await fs.readFile(path.join(bundle, 'state.json'), 'utf8'));
  const calls = Object.values(state.inference_calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inference_call_id, started[0].payload.inference_call_id);
  assert.equal(calls[0].execution.status, mode);
  assert.equal(calls[0].execution.started_at_unix_ms, started[0].wall_time_unix_ms);
  assert.equal(calls[0].execution.ended_at_unix_ms, terminal[0].wall_time_unix_ms);
  assert.equal(calls[0].response_id, mode === 'completed' ? 'probe-completed' : null);
  assert.ok(calls[0].response_item_ids.length > 0, 'partial output must remain available even for a failed response');
  return { mode, requests, startedBeforeCompletion, terminal: terminal[0].payload.type,
    reducedStatus: calls[0].execution.status, rawEventCount: raw.length, schemaVersion,
    startTimestamp: started[0].wall_time_unix_ms, endTimestamp: terminal[0].wall_time_unix_ms,
    reducer: 'passed', blockedOutboundHosts: [...blockedOutbound], bundle: path.relative(root, bundle) };
}
async function main() {
  const binaries = process.argv.slice(2);
  assert.ok(binaries.length && binaries.every(p => path.isAbsolute(p) && p.toLowerCase().endsWith('.exe')), 'supply absolute paths to installed codex.exe binaries');
  const target = path.resolve(__dirname, '../target'); await fs.mkdir(target, { recursive: true });
  const root = await fs.mkdtemp(path.join(target, 'rollout-trace-probe-'));
  console.log(`Isolated artifacts: ${root}`);
  const reports = [];
  for (let i = 0; i < binaries.length; i++) {
    const binary = binaries[i];
    const env = isolatedEnvironment(root);
    const version = await run(binary, ['--version'], root, env);
    assert.equal(version.code, 0, version.stderr);
    const help = await run(binary, ['debug', 'trace-reduce', '--help'], root, env);
    assert.equal(help.code, 0, help.stderr);
    const report = { binary, version: version.stdout.trim(), sha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'), cases: [] };
    for (const mode of ['completed', 'failed']) {
      const result = await probeCase(binary, path.join(root, `binary-${i}-${mode}`), mode);
      report.cases.push(result); console.log(`PASS: ${report.version} ${mode} / live start / terminal identity / reducer`);
    }
    reports.push(report);
  }
  const report = { createdAt: new Date().toISOString(), scope: 'isolated CLI processes, loopback-only synthetic provider; existing Desktop sessions unchanged', reports };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
