//! Read-only projection of local Codex rollout JSONL. No Desktop/API control.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};
use tauri::{Emitter, Manager};

const HISTORY_BYTES: u64 = 4 * 1024 * 1024;
const READ_BYTES: u64 = 512 * 1024;
const LINE_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 800;
const DETAIL_CHARS: usize = 32 * 1024;

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    label: String,
    thread_id: Option<String>,
    file_name: String,
    modified: u64,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    id: String,
    turn_id: String,
    step: u32,
    kind: String,
    summary: String,
    timestamp: Option<String>,
    source_type: String,
    call_id: Option<String>,
    status: Option<String>,
    #[serde(skip)]
    detail: Value,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    session_id: Option<String>,
    automatic: bool,
    sessions: Vec<Session>,
    events: Vec<RuntimeEvent>,
    turn_status: HashMap<String, String>,
    notice: String,
    error: Option<String>,
}

#[derive(Default)]
struct Projection {
    events: VecDeque<RuntimeEvent>,
    turn: String,
    step: u32,
    after_result: bool,
    turn_status: HashMap<String, String>,
    calls: HashMap<String, (String, u32)>,
    // Only paired legacy/raw duplicates are folded, never repeated same-source messages.
    messages: VecDeque<(String, String, String, String, String)>,
    skipped: usize,
    dropped: usize,
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn short(text: &str, limit: usize) -> String {
    let mut chars = text.chars();
    let mut out: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        out.push_str("… [已截断]");
    }
    out
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.as_str().or_else(|| v.get("text").and_then(Value::as_str)))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

// Bound Inspector data; binary/encrypted payloads are not useful runtime text.
fn bounded(value: &Value, budget: &mut usize) -> Value {
    if *budget == 0 {
        return json!("[已截断]");
    }
    *budget -= 1;
    match value {
        Value::String(s) => {
            let result = short(s, (*budget).min(DETAIL_CHARS));
            *budget = budget.saturating_sub(result.len());
            Value::String(result)
        }
        Value::Array(items) => {
            Value::Array(items.iter().take(100).map(|v| bounded(v, budget)).collect())
        }
        Value::Object(object) => Value::Object(
            object
                .iter()
                .take(100)
                .map(|(k, v)| {
                    let hidden = k.contains("encrypted")
                        || matches!(k.as_str(), "image_url" | "audio" | "bytes" | "base64");
                    (
                        k.clone(),
                        if hidden {
                            json!("[二进制 / 加密内容省略]")
                        } else {
                            bounded(v, budget)
                        },
                    )
                })
                .collect(),
        ),
        _ => value.clone(),
    }
}

impl Projection {
    fn ingest(&mut self, bytes: &[u8], offset: u64) {
        let Ok(line) = serde_json::from_slice::<Value>(bytes) else {
            self.skipped += 1;
            return;
        };
        let outer = line["type"].as_str().unwrap_or("unknown");
        let envelope = &line["payload"];
        let completed_item = outer == "event_msg" && envelope["type"] == "item_completed";
        let p = if completed_item {
            &envelope["item"]
        } else {
            envelope
        };
        let subtype = p["type"].as_str().unwrap_or(outer);
        if outer == "session_meta" {
            return;
        }
        if let Some(id) =
            string(envelope, "turn_id").or_else(|| string(&line["metadata"], "turn_id"))
        {
            if id != self.turn {
                self.turn = id;
                self.step = 0;
                self.after_result = false;
            }
        }
        if self.turn.is_empty() {
            self.turn = "unattributed".into();
        }
        if outer == "turn_context" {
            return;
        }
        // Per-token legacy mirrors and quota bookkeeping are not trajectory rows.
        if subtype.ends_with("_delta")
            || matches!(subtype, "token_count" | "agent_reasoning_raw_content")
        {
            return;
        }

        let (kind, content) = match (outer, subtype) {
            ("event_msg", "UserMessage") => ("user", text_content(&p["content"])),
            ("event_msg", "AgentMessage") => ("assistant", text_content(&p["content"])),
            ("event_msg", "Plan") => ("assistant", text_content(&p["text"])),
            ("event_msg", "Reasoning") => {
                let summary = text_content(&p["summary_text"]);
                if summary.is_empty() {
                    return;
                }
                ("summary", summary)
            }
            ("event_msg", "CommandExecution") => ("tool", text_content(&p["command"])),
            (
                "event_msg",
                "McpToolCall"
                | "DynamicToolCall"
                | "CollabAgentToolCall"
                | "WebSearch"
                | "FileChange"
                | "ImageGeneration",
            ) => (
                "tool",
                format!(
                    "{} {}",
                    p["tool"].as_str().unwrap_or(subtype),
                    text_content(&p["arguments"])
                ),
            ),
            ("event_msg", "FunctionCallOutput") => ("result", text_content(&p["output"])),
            ("event_msg", "task_started" | "turn_started") => {
                self.turn_status.insert(self.turn.clone(), "started".into());
                ("lifecycle", "回合开始".to_string())
            }
            ("event_msg", "task_complete" | "turn_complete") => {
                self.turn_status.insert(
                    self.turn.clone(),
                    if p["error"].is_null() {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into(),
                );
                ("lifecycle", "回合结束".to_string())
            }
            ("event_msg", "turn_aborted") => {
                self.turn_status.insert(self.turn.clone(), "aborted".into());
                ("lifecycle", "回合中断".to_string())
            }
            ("event_msg", "user_message") => ("user", text_content(&p["message"])),
            ("event_msg", "agent_message") => ("assistant", text_content(&p["message"])),
            ("event_msg", "agent_reasoning") => ("summary", text_content(&p["text"])),
            ("response_item", "message") => {
                let role = p["role"].as_str().unwrap_or("context");
                (
                    if role == "user" {
                        "user"
                    } else if role == "assistant" {
                        "assistant"
                    } else {
                        "context"
                    },
                    text_content(&p["content"]),
                )
            }
            ("response_item", "reasoning") => {
                let summary = text_content(&p["summary"]);
                if summary.is_empty() {
                    return;
                }
                ("summary", summary)
            }
            (
                "response_item",
                "function_call"
                | "custom_tool_call"
                | "local_shell_call"
                | "tool_search_call"
                | "web_search_call"
                | "image_generation_call",
            ) => {
                let args = p
                    .get("arguments")
                    .or_else(|| p.get("input"))
                    .or_else(|| p.get("action"))
                    .unwrap_or(&Value::Null);
                (
                    "tool",
                    format!(
                        "{} {}",
                        p["name"].as_str().unwrap_or(subtype),
                        text_content(args)
                    ),
                )
            }
            (
                "response_item",
                "function_call_output" | "custom_tool_call_output" | "tool_search_output",
            ) => ("result", text_content(&p["output"])),
            (
                _,
                "compacted" | "context_compaction" | "compaction" | "context_compacted"
                | "ContextCompaction",
            ) => ("compaction", "Context compaction".into()),
            ("event_msg", "error" | "warning") => ("error", text_content(&p["message"])),
            _ => ("context", subtype.to_string()),
        };
        // Some Codex versions persist both event_msg and response_item for one message.
        // Fold only an equal cross-source pair within this turn; keep source provenance.
        if matches!(kind, "user" | "assistant" | "summary") {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            content.hash(&mut hash);
            let fingerprint = hash.finish().to_string();
            let source = if completed_item {
                "item_completed"
            } else {
                outer
            };
            if let Some(index) = self
                .messages
                .iter()
                .position(|(turn, k, previous, text, _)| {
                    turn == &self.turn && k == kind && previous != source && text == &fingerprint
                })
            {
                if let Some((_, _, _, _, id)) = self.messages.remove(index) {
                    if let Some(event) = self.events.iter_mut().find(|e| e.id == id) {
                        let mut mirror = line.clone();
                        if subtype == "reasoning" {
                            mirror["payload"]
                                .as_object_mut()
                                .map(|v| v.remove("content"));
                        }
                        if subtype == "Reasoning" {
                            mirror["payload"]["item"]
                                .as_object_mut()
                                .map(|v| v.remove("raw_content"));
                        }
                        event.detail["mirror"] = bounded(&mirror, &mut DETAIL_CHARS.clone());
                    }
                }
                return;
            }
            self.messages.push_back((
                self.turn.clone(),
                kind.into(),
                source.into(),
                fingerprint,
                offset.to_string(),
            ));
            if self.messages.len() > 32 {
                self.messages.pop_front();
            }
        }
        if matches!(kind, "assistant" | "summary" | "tool") && (self.step == 0 || self.after_result)
        {
            self.step += 1;
            self.after_result = false;
        }
        let call_id = string(p, "call_id");
        let mut turn_id = self.turn.clone();
        let mut step = if matches!(kind, "user" | "lifecycle") {
            0
        } else {
            self.step
        };
        if kind == "tool" {
            if let Some(id) = &call_id {
                self.calls.insert(id.clone(), (turn_id.clone(), step));
            }
        } else if kind == "result" {
            if let Some(group) = call_id.as_ref().and_then(|id| self.calls.get(id)) {
                turn_id = group.0.clone();
                step = group.1;
            }
            self.after_result = true;
        }
        let mut raw = line.clone();
        // Render only exposed reasoning summaries, never encrypted/raw reasoning bodies.
        if subtype == "reasoning" {
            raw["payload"].as_object_mut().map(|v| v.remove("content"));
        }
        if subtype == "Reasoning" {
            raw["payload"]["item"]
                .as_object_mut()
                .map(|v| v.remove("raw_content"));
        }
        let raw = bounded(&raw, &mut DETAIL_CHARS.clone());
        let detail =
            json!({ "raw": raw, "content": short(&content, DETAIL_CHARS), "byteOffset": offset });
        self.events.push_back(RuntimeEvent {
            id: offset.to_string(),
            turn_id,
            step,
            kind: kind.into(),
            summary: short(
                &content.split_whitespace().collect::<Vec<_>>().join(" "),
                170,
            ),
            timestamp: string(&line, "timestamp"),
            source_type: if completed_item {
                format!("event_msg.item_completed.{subtype}")
            } else {
                format!("{outer}.{subtype}")
            },
            call_id,
            status: string(p, "status"),
            detail,
        });
        if completed_item && kind == "tool" {
            self.after_result = true;
        }
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
            self.dropped += 1;
        }
        if self.calls.len() > MAX_EVENTS {
            self.calls
                .retain(|id, _| self.events.iter().any(|e| e.call_id.as_ref() == Some(id)));
        }
        self.turn_status
            .retain(|turn, _| self.events.iter().any(|e| &e.turn_id == turn));
    }
}

struct Tail {
    path: PathBuf,
    offset: u64,
    line_start: u64,
    pending: Vec<u8>,
    discarding: bool,
    truncated: bool,
    created: Option<SystemTime>,
    checkpoint: Vec<u8>,
    projection: Projection,
}

impl Tail {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            line_start: 0,
            pending: Vec::new(),
            discarding: false,
            truncated: false,
            created: None,
            checkpoint: Vec::new(),
            projection: Projection::default(),
        }
    }
    fn poll(&mut self) -> Result<bool, String> {
        let mut file = File::open(&self.path).map_err(|e| format!("无法读取会话日志：{e}"))?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        let mut reset = meta.len() < self.offset
            || (self.created.is_some() && meta.created().ok() != self.created);
        if !reset && !self.checkpoint.is_empty() {
            file.seek(SeekFrom::Start(self.offset - self.checkpoint.len() as u64))
                .map_err(|e| e.to_string())?;
            let mut check = vec![0; self.checkpoint.len()];
            reset = file.read_exact(&mut check).is_err() || check != self.checkpoint;
        }
        if reset {
            *self = Self::new(self.path.clone());
        }
        self.created = meta.created().ok();
        if self.offset == 0 && meta.len() > HISTORY_BYTES {
            self.offset = meta.len() - HISTORY_BYTES;
            self.line_start = self.offset;
            self.discarding = true;
            self.truncated = true;
        }
        if meta.len() == self.offset {
            return Ok(reset);
        }
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(READ_BYTES)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        for byte in bytes {
            self.offset += 1;
            if byte == b'\n' {
                if !self.discarding && !self.pending.is_empty() {
                    self.projection.ingest(&self.pending, self.line_start);
                }
                self.pending.clear();
                self.discarding = false;
                self.line_start = self.offset;
            } else if !self.discarding {
                self.pending.push(byte);
                if self.pending.len() > LINE_BYTES {
                    self.pending.clear();
                    self.discarding = true;
                    self.projection.skipped += 1;
                }
            }
        }
        let count = self.offset.min(64) as usize;
        let mut file = File::open(&self.path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(self.offset - count as u64))
            .map_err(|e| e.to_string())?;
        self.checkpoint = vec![0; count];
        file.read_exact(&mut self.checkpoint)
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
}

fn rollout_thread_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    let valid = id.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) {
            c == b'-'
        } else {
            c.is_ascii_hexdigit()
        }
    });
    valid.then(|| id.to_ascii_lowercase())
}

fn resolve_session_names(root: &Path, sessions: &mut [Session]) {
    let Some(home) = root.parent() else {
        return;
    };
    let Ok(mut file) = File::open(home.join("session_index.jsonl")) else {
        return;
    };
    let Ok(meta) = file.metadata() else {
        return;
    };
    // The index is append-only. A bounded tail covers recent names without ever
    // loading an unbounded index or inspecting unrelated session content.
    const INDEX_BYTES: u64 = 8 * 1024 * 1024;
    let start = meta.len().saturating_sub(INDEX_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    let mut bytes = Vec::new();
    if file.take(INDEX_BYTES).read_to_end(&mut bytes).is_err() {
        return;
    }
    apply_session_names(&bytes, start > 0, sessions);
}

fn apply_session_names(bytes: &[u8], partial_start: bool, sessions: &mut [Session]) {
    let mut names = HashMap::new();
    // split_inclusive rejects the unfinished final line while a rename is writing.
    for (index, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
        if (index == 0 && partial_start) || line.last() != Some(&b'\n') {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let (Some(id), Some(name)) = (entry["id"].as_str(), entry["thread_name"].as_str()) else {
            continue;
        };
        let id = id.to_ascii_lowercase();
        if sessions.iter().any(|s| s.thread_id.as_ref() == Some(&id)) {
            // A latest empty name clears the title; do not resurrect an older name.
            names.insert(id, short(name.trim(), 240));
        }
    }
    for session in sessions {
        if let Some(name) = session
            .thread_id
            .as_ref()
            .and_then(|id| names.get(id))
            .filter(|name| !name.is_empty())
        {
            session.label = name.clone();
        }
    }
}

fn discover(root: &Path) -> Vec<Session> {
    // Bounded depth, no symlinks/junction traversal. Only sessions/**/rollout-*.jsonl.
    let mut dirs = vec![(root.to_path_buf(), 0)];
    let mut sessions = Vec::new();
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() && depth < 3 {
                dirs.push((path, depth + 1));
            } else if kind.is_file()
                && path.extension().is_some_and(|e| e == "jsonl")
                && entry.file_name().to_string_lossy().starts_with("rollout-")
            {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|v| v.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map_or(0, |v| v.as_millis() as u64);
                let id = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                let label = entry
                    .file_name()
                    .to_string_lossy()
                    .trim_start_matches("rollout-")
                    .trim_end_matches(".jsonl")
                    .to_string();
                sessions.push(Session {
                    id,
                    label,
                    thread_id: rollout_thread_id(&path),
                    file_name: entry.file_name().to_string_lossy().to_string(),
                    path,
                    modified,
                });
            }
        }
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.id.cmp(&b.id)));
    sessions.truncate(40);
    sessions
}

struct Service {
    root: PathBuf,
    selected: Option<String>,
    tail: Option<Tail>,
    snapshot: Snapshot,
    scanned: Option<Instant>,
}

impl Service {
    fn tick(&mut self) -> bool {
        let mut changed = false;
        if self
            .scanned
            .is_none_or(|t| t.elapsed() >= Duration::from_secs(3))
        {
            let mut sessions = discover(&self.root);
            // A pinned session must remain readable after falling out of the recent 40.
            if let Some(old) = self
                .snapshot
                .sessions
                .iter()
                .find(|s| Some(&s.id) == self.selected.as_ref())
            {
                if !sessions.iter().any(|s| s.id == old.id) {
                    sessions.push(old.clone());
                }
            }
            // Re-resolve even for a pinned old session; renames need no rollout write.
            for session in &mut sessions {
                session.label = session
                    .file_name
                    .trim_start_matches("rollout-")
                    .trim_end_matches(".jsonl")
                    .to_string();
            }
            resolve_session_names(&self.root, &mut sessions);
            changed = sessions != self.snapshot.sessions;
            self.snapshot.sessions = sessions;
            self.scanned = Some(Instant::now());
        }
        let selected = self
            .selected
            .as_ref()
            .and_then(|id| self.snapshot.sessions.iter().find(|s| &s.id == id))
            .or_else(|| {
                if self.selected.is_none() {
                    self.snapshot.sessions.first()
                } else {
                    None
                }
            });
        let id = selected.map(|s| s.id.clone());
        if self.snapshot.session_id != id {
            self.tail = selected.map(|s| Tail::new(s.path.clone()));
            self.snapshot.session_id = id;
            changed = true;
        }
        let error = if let Some(tail) = &mut self.tail {
            match tail.poll() {
                Ok(value) => {
                    changed |= value;
                    None
                }
                Err(error) => Some(error),
            }
        } else {
            None
        };
        changed |= self.snapshot.error != error;
        self.snapshot.error = error;
        self.snapshot.automatic = self.selected.is_none();
        if changed {
            self.snapshot.events = self
                .tail
                .as_ref()
                .map(|t| t.projection.events.iter().cloned().collect())
                .unwrap_or_default();
            self.snapshot.turn_status = self
                .tail
                .as_ref()
                .map(|t| t.projection.turn_status.clone())
                .unwrap_or_default();
            self.snapshot.notice = match &self.tail {
                None => "未找到本地 rollout JSONL；开始一轮 Codex 对话后自动发现".into(),
                Some(t) => format!(
                    "只读本地 JSONL · Step 为展示分组{}{}{}",
                    if t.truncated {
                        " · 仅最近 4 MiB"
                    } else {
                        ""
                    },
                    if t.projection.dropped > 0 {
                        " · 仅保留最近 800 个事件"
                    } else {
                        ""
                    },
                    if t.projection.skipped > 0 {
                        " · 已跳过无效或超大记录"
                    } else {
                        ""
                    }
                ),
            };
            self.snapshot.revision += 1;
        }
        changed
    }
}

pub struct RuntimeState(Mutex<Service>);

#[tauri::command]
pub async fn get_runtime_snapshot(app: tauri::AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let service = state.0.lock().map_err(|e| e.to_string())?;
        Ok(service.snapshot.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn select_runtime_session(
    app: tauri::AppHandle,
    id: Option<String>,
) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let mut service = state.0.lock().map_err(|e| e.to_string())?;
        if id
            .as_ref()
            .is_some_and(|id| !service.snapshot.sessions.iter().any(|s| &s.id == id))
        {
            return Err("会话不在已发现的本地日志列表中".into());
        }
        service.selected = id;
        service.tick();
        service.snapshot.revision += 1;
        let snapshot = service.snapshot.clone();
        drop(service);
        let _ = app.emit_to("codex-tray", "runtime-snapshot", &snapshot);
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_runtime_event(
    app: tauri::AppHandle,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<RuntimeState>();
        let service = state.0.lock().map_err(|e| e.to_string())?;
        if service.snapshot.session_id.as_ref() != Some(&session_id) {
            return Err("会话已切换，请重新选择事件".into());
        }
        let event = service
            .snapshot
            .events
            .iter()
            .find(|e| e.id == id)
            .ok_or("事件已移出最近记录窗口")?;
        let related: Vec<_> = service
            .snapshot
            .events
            .iter()
            .filter(|e| {
                e.id != id
                    && e.call_id.is_some()
                    && e.call_id == event.call_id
                    && e.turn_id == event.turn_id
            })
            .map(|e| json!({ "event": e, "detail": e.detail }))
            .collect();
        Ok(json!({ "event": event, "detail": event.detail, "related": related }))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn setup(app: &tauri::AppHandle) {
    let root = std::env::var_os("CODEX_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
        .join("sessions");
    app.manage(RuntimeState(Mutex::new(Service {
        root,
        selected: None,
        tail: None,
        snapshot: Snapshot {
            automatic: true,
            notice: "未找到本地 rollout JSONL；开始一轮 Codex 对话后自动发现".into(),
            ..Default::default()
        },
        scanned: None,
    })));
    let app = app.clone();
    std::thread::spawn(move || loop {
        if crate::tray_mode::active(&app) {
            let state = app.state::<RuntimeState>();
            if let Ok(mut service) = state.0.lock() {
                if service.tick() {
                    let _ = app.emit_to("codex-tray", "runtime-snapshot", service.snapshot.clone());
                }
            };
        }
        std::thread::sleep(Duration::from_millis(500));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titles_map_by_thread_id_and_follow_latest_complete_rename() {
        let id = "019a6b3c-1234-5678-9abc-0123456789ab";
        let path = PathBuf::from(format!("rollout-2026-11-09T12-30-00-{id}.jsonl"));
        assert_eq!(rollout_thread_id(&path).as_deref(), Some(id));
        assert_eq!(rollout_thread_id(Path::new("rollout-no-id.jsonl")), None);
        let mut sessions = vec![Session {
            id: "file-key".into(),
            label: "fallback".into(),
            thread_id: Some(id.into()),
            file_name: "original.jsonl".into(),
            path,
            modified: 1,
        }];
        let index = format!("{{\"id\":\"{id}\",\"thread_name\":\"旧名字\"}}\ninvalid\n{{\"id\":\"other\",\"thread_name\":\"不应匹配\"}}\n{{\"id\":\"{id}\",\"thread_name\":\"新名字\"}}\n{{\"id\":\"{id}\",\"thread_name\":\"未写完\"}}");
        apply_session_names(index.as_bytes(), false, &mut sessions);
        assert_eq!(sessions[0].label, "新名字");
        assert_eq!(sessions[0].id, "file-key");
        sessions[0].label = "fallback".into();
        apply_session_names(
            format!("{index}\n{{\"id\":\"{id}\",\"thread_name\":\"\"}}\n").as_bytes(),
            false,
            &mut sessions,
        );
        assert_eq!(sessions[0].label, "fallback");
    }
    fn feed(p: &mut Projection, offset: u64, outer: &str, payload: Value) {
        p.ingest(
            serde_json::to_string(
                &json!({ "timestamp": "2026-11-09T00:00:00Z", "type": outer, "payload": payload }),
            )
            .unwrap()
            .as_bytes(),
            offset,
        );
    }
    #[test]
    fn real_turns_calls_results_and_unknown_fields() {
        let mut p = Projection::default();
        feed(
            &mut p,
            0,
            "event_msg",
            json!({"type":"task_started", "turn_id":"t1"}),
        );
        feed(
            &mut p,
            1,
            "response_item",
            json!({"type":"function_call", "name":"exec", "call_id":"c1", "arguments":"{}"}),
        );
        feed(
            &mut p,
            2,
            "response_item",
            json!({"type":"function_call_output", "call_id":"c1", "output":"done"}),
        );
        feed(
            &mut p,
            3,
            "response_item",
            json!({"type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"done"}]}),
        );
        feed(
            &mut p,
            4,
            "event_msg",
            json!({"type":"task_complete", "turn_id":"t1"}),
        );
        assert_eq!(p.events[1].step, p.events[2].step);
        assert_eq!(p.events[3].step, 2);
        assert_eq!(p.turn_status["t1"], "completed");
        assert!(p.events[1].status.is_none()); // An output is not proof of success.
        feed(&mut p, 5, "future_item", json!({"foo":1}));
        assert_eq!(p.events.back().unwrap().kind, "context");
    }
    #[test]
    fn duplicate_mirrors_are_folded_but_repeated_messages_survive() {
        let mut p = Projection::default();
        for i in 0..2 {
            feed(
                &mut p,
                i * 2,
                "event_msg",
                json!({"type":"user_message", "message":"hello"}),
            );
            feed(
                &mut p,
                i * 2 + 1,
                "response_item",
                json!({"type":"message", "role":"user", "content":[{"text":"hello"}]}),
            );
        }
        assert_eq!(p.events.len(), 2);
    }
    #[test]
    fn empty_encrypted_reasoning_is_not_fabricated() {
        let mut p = Projection::default();
        feed(
            &mut p,
            0,
            "response_item",
            json!({"type":"reasoning", "summary":[], "encrypted_content":"secret"}),
        );
        assert!(p.events.is_empty());
    }
    #[test]
    fn paginated_items_preserve_real_status_and_omit_raw_reasoning() {
        let mut p = Projection::default();
        feed(
            &mut p,
            0,
            "event_msg",
            json!({"type":"item_completed", "turn_id":"new-turn", "item":{"type":"CommandExecution", "id":"item1", "command":["npm", "test"], "aggregated_output":"passed", "exit_code":0, "status":"completed"}}),
        );
        assert_eq!(p.events[0].summary, "npm test");
        assert_eq!(p.events[0].status.as_deref(), Some("completed"));
        assert_eq!(p.events[0].turn_id, "new-turn");
        assert!(p.events[0].call_id.is_none()); // item ID is not a known call ID.
        feed(
            &mut p,
            1,
            "event_msg",
            json!({"type":"item_completed", "turn_id":"new-turn", "item":{"type":"Reasoning", "summary_text":["Public summary"], "raw_content":["private"]}}),
        );
        assert_eq!(p.events[1].summary, "Public summary");
        assert!(p.events[1].detail["raw"]["payload"]["item"]
            .get("raw_content")
            .is_none());
    }
    #[test]
    fn history_is_bounded_and_malformed_records_do_not_poison_the_next_line() {
        let mut p = Projection::default();
        p.ingest(b"{invalid", 0);
        for i in 1..=MAX_EVENTS + 10 {
            feed(
                &mut p,
                i as u64,
                "event_msg",
                json!({"type":"user_message", "message":"repeat"}),
            );
        }
        assert_eq!(p.events.len(), MAX_EVENTS);
        assert_eq!(p.dropped, 10);
        assert_eq!(p.skipped, 1);
    }
    #[test]
    fn incremental_utf8_partial_line_and_truncation() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "wisland-tail-{}-{}.jsonl",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bytes = b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n";
        fs::write(&path, &bytes[..20]).unwrap();
        let mut tail = Tail::new(path.clone());
        tail.poll().unwrap();
        assert!(tail.projection.events.is_empty());
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&bytes[20..])
            .unwrap();
        tail.poll().unwrap();
        assert_eq!(tail.projection.events.len(), 1);
        assert!(!tail.poll().unwrap());
        fs::write(&path, b"{}\n").unwrap();
        tail.poll().unwrap();
        assert_eq!(tail.projection.events.len(), 1);
        assert_eq!(tail.projection.events[0].id, "0");
        fs::remove_file(path).unwrap();
    }
}
