//! Read-only projection of local Codex rollout JSONL. No Desktop/API control.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
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

#[path = "runtime_catalog.rs"]
mod catalog;
use catalog::{Segment, Session};
#[path = "runtime_model.rs"]
mod model;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    id: String,
    turn_id: String,
    turn_number: Option<u32>,
    model_call: Option<ModelCall>,
    kind: String,
    summary: String,
    timestamp: Option<String>,
    source_type: String,
    call_id: Option<String>,
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_presentation: Option<model::ModelPresentation>,
    #[serde(skip)]
    continuity: u64,
    #[serde(skip)]
    input_boundary: bool,
    #[serde(skip)]
    detail: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCall {
    response_id: String,
    number: u32,
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
    source: String,
    events: VecDeque<RuntimeEvent>,
    turn: String,
    turn_numbers: HashMap<String, u32>,
    next_turn: u32,
    next_model_call: u32,
    model_calls: HashMap<(String, String), String>,
    turn_status: HashMap<String, String>,
    calls: HashMap<String, String>,
    // Only paired legacy/raw duplicates are folded, never repeated same-source messages.
    messages: VecDeque<(String, String, String, String, String)>,
    skipped: usize,
    dropped: usize,
    continuity: u64,
    model_view: model::ModelView,
    input_boundary: bool,
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
        let event_id = if self.source.is_empty() {
            offset.to_string()
        } else {
            format!("{}:{offset}", self.source)
        };
        let Ok(line) = serde_json::from_slice::<Value>(bytes) else {
            self.skipped += 1;
            self.continuity += 1;
            self.input_boundary = false;
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
            self.continuity += 1;
            self.input_boundary = false;
            return;
        }
        let explicit_turn =
            string(envelope, "turn_id").or_else(|| string(&line["metadata"], "turn_id"));
        // A late tool result or usage record may name an older turn. It must
        // not redirect subsequent records that rely on the active turn.
        if let Some(id) = &explicit_turn {
            if self.turn.is_empty()
                || outer == "turn_context"
                || matches!(subtype, "task_started" | "turn_started")
            {
                self.turn = id.clone();
            }
        }
        if self.turn.is_empty() {
            self.turn = "unattributed".into();
        }
        if outer == "turn_context" {
            self.continuity += 1;
            self.input_boundary = true;
            return;
        }
        let has_explicit_turn = explicit_turn.is_some();
        let record_turn = explicit_turn.unwrap_or_else(|| self.turn.clone());
        // Per-token legacy mirrors and quota bookkeeping are not trajectory rows.
        if subtype.ends_with("_delta")
            || matches!(subtype, "token_count" | "agent_reasoning_raw_content")
        {
            return;
        }

        // Usage is also persisted for incomplete responses. Only the explicit
        // response-completed event proves completion; neither proves tool success.
        let model_call = if outer == "token_usage_record"
            || (outer == "event_msg" && subtype == "raw_response_completed")
        {
            if let Some(response_id) = string(p, "response_id").filter(|id| !id.is_empty()) {
                let key = (record_turn.clone(), response_id.clone());
                if let Some(id) = self.model_calls.get(&key) {
                    if let Some(event) = self.events.iter_mut().find(|e| &e.id == id) {
                        if subtype == "raw_response_completed"
                            || event.detail["mirror"]["payload"]["type"] != "raw_response_completed"
                        {
                            event.detail["mirror"] = bounded(&line, &mut DETAIL_CHARS.clone());
                        }
                        if subtype == "raw_response_completed" {
                            event.status = Some("response_completed".into());
                            event.summary = "响应已结束".into();
                        }
                    }
                    return;
                }
                self.next_model_call += 1;
                self.model_calls.insert(key, event_id.clone());
                self.messages.clear(); // Equal text in a later response is not a mirror.
                Some(ModelCall {
                    response_id,
                    number: self.next_model_call,
                })
            } else {
                None
            }
        } else {
            None
        };

        let (kind, content) = if model_call.is_some() {
            (
                "model",
                if subtype == "raw_response_completed" {
                    "响应已结束"
                } else {
                    "已记录用量"
                }
                .into(),
            )
        } else {
            match (outer, subtype) {
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
                    self.turn_status
                        .insert(record_turn.clone(), "started".into());
                    ("lifecycle", "回合开始".to_string())
                }
                ("event_msg", "task_complete" | "turn_complete") => {
                    self.turn_status.insert(
                        record_turn.clone(),
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
                    self.turn_status
                        .insert(record_turn.clone(), "aborted".into());
                    ("lifecycle", "回合中断".to_string())
                }
                ("event_msg", "user_message") => ("user", text_content(&p["message"])),
                ("event_msg", "agent_message") => ("assistant", text_content(&p["message"])),
                ("event_msg", "agent_reasoning") => ("summary", text_content(&p["text"])),
                ("response_item", "message") => {
                    let role = p["role"].as_str().unwrap_or("");
                    (
                        if role == "user" {
                            "user"
                        } else if role == "assistant" {
                            "assistant"
                        } else if role == "system" || role == "developer" {
                            "system"
                        } else if role == "context" {
                            "context"
                        } else {
                            "record"
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
                // Keep known context state separate from unclassified bookkeeping.
                ("world_state", _) => ("context", "上下文环境更新".into()),
                ("response_item", "additional_tools") => ("context", "上下文工具更新".into()),
                ("response_item", "configuration_update") => ("context", "上下文配置更新".into()),
                _ => ("record", subtype.to_string()),
            }
        };
        // Some Codex versions persist both event_msg and response_item for one message.
        // Fold only an equal cross-source pair within this turn; keep source provenance.
        if matches!(kind, "user" | "assistant" | "summary") {
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            content.hash(&mut hash);
            self.continuity.hash(&mut hash);
            (line["metadata"]["compaction_output"] == true).hash(&mut hash);
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
                    turn == &record_turn && k == kind && previous != source && text == &fingerprint
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
                record_turn.clone(),
                kind.into(),
                source.into(),
                fingerprint,
                event_id.clone(),
            ));
            if self.messages.len() > 32 {
                self.messages.pop_front();
            }
        }
        let call_id = string(p, "call_id");
        let mut turn_id = record_turn;
        if kind == "tool" {
            if let Some(id) = &call_id {
                self.calls.insert(id.clone(), turn_id.clone());
            }
        } else if kind == "result" && !has_explicit_turn {
            if let Some(turn) = call_id.as_ref().and_then(|id| self.calls.get(id)) {
                turn_id = turn.clone();
            }
        }
        let turn_number = if turn_id == "unattributed" {
            None
        } else {
            Some(
                *self.turn_numbers.entry(turn_id.clone()).or_insert_with(|| {
                    self.next_turn += 1;
                    self.next_turn
                }),
            )
        };
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
        let detail = json!({ "raw": raw, "content": short(&content, DETAIL_CHARS), "byteOffset": offset, "rolloutId": self.source });
        self.events.push_back(RuntimeEvent {
            id: event_id,
            turn_id,
            turn_number,
            model_call,
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
            status: if kind == "model" {
                Some(
                    if subtype == "raw_response_completed" {
                        "response_completed"
                    } else {
                        "usage_recorded"
                    }
                    .into(),
                )
            } else {
                string(p, "status")
            },
            detail,
            model_presentation: None,
            continuity: self.continuity,
            input_boundary: std::mem::take(&mut self.input_boundary),
        });
        while self.events.len() > MAX_EVENTS {
            if let Some(event) = self.events.pop_front() {
                if let Some(call) = event.model_call {
                    self.model_calls.remove(&(event.turn_id, call.response_id));
                }
            }
            self.dropped += 1;
        }
        if self.calls.len() > MAX_EVENTS {
            self.calls
                .retain(|id, _| self.events.iter().any(|e| e.call_id.as_ref() == Some(id)));
        }
        self.turn_status
            .retain(|turn, _| self.events.iter().any(|e| &e.turn_id == turn));
        self.turn_numbers
            .retain(|turn, _| self.events.iter().any(|e| &e.turn_id == turn));
    }
}

struct Tail {
    path: PathBuf,
    lineage: Vec<Segment>,
    history_note: String,
    initialized: bool,
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
            lineage: Vec::new(),
            history_note: String::new(),
            initialized: false,
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
    fn from_session(session: &Session) -> Self {
        let mut tail = Self::new(session.path.clone());
        tail.lineage = session.lineage.clone();
        tail.history_note = [
            session.selection_note.as_str(),
            session.history_note.as_str(),
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
        tail
    }
    fn seed_history(&mut self, leaf_len: u64) -> Result<(), String> {
        // One aggregate 4 MiB window, allocated newest first across the retained
        // lineage. Never read abandoned records past a history_base cutoff.
        let mut budget = HISTORY_BYTES.saturating_sub(leaf_len);
        let mut ranges = Vec::new();
        for segment in self.lineage.iter().rev().skip(1) {
            let end = segment.end.as_ref().ok_or("历史源缺少读取边界")?;
            let count = end.bytes.min(budget);
            budget -= count;
            self.truncated |= count < end.bytes;
            if count > 0 {
                ranges.push((segment.clone(), end.bytes - count, end.bytes));
            }
        }
        for (segment, start, end) in ranges.into_iter().rev() {
            let mut file = File::open(&segment.path).map_err(|e| format!("无法读取历史源：{e}"))?;
            if file.metadata().map_err(|e| e.to_string())?.len() < end {
                return Err("历史源已缩短，等待重新扫描".into());
            }
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            file.take(end - start)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            self.projection.source = segment.rollout_id;
            let mut offset = start;
            for (index, line) in bytes.split_inclusive(|b| *b == b'\n').enumerate() {
                if !(index == 0 && start > 0) && line.last() == Some(&b'\n') {
                    if line.len() <= LINE_BYTES {
                        // New paginated records also carry ordinals. Respect both
                        // cutoffs when available; legacy lines only have byte offsets.
                        let outside = serde_json::from_slice::<Value>(line)
                            .ok()
                            .and_then(|v| v["ordinal"].as_u64())
                            .is_some_and(|n| n >= segment.end.as_ref().unwrap().ordinal);
                        if !outside {
                            self.projection.ingest(line, offset);
                        }
                    } else {
                        self.projection.skipped += 1;
                        self.projection.continuity += 1;
                        self.projection.input_boundary = false;
                    }
                }
                offset += line.len() as u64;
            }
            self.projection.messages.clear();
        }
        self.projection.source = self
            .lineage
            .last()
            .map(|s| s.rollout_id.clone())
            .unwrap_or_default();
        self.initialized = true;
        Ok(())
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
            let lineage = self.lineage.clone();
            let note = self.history_note.clone();
            *self = Self::new(self.path.clone());
            self.lineage = lineage;
            self.history_note = note;
        }
        self.created = meta.created().ok();
        let seeded = !self.initialized;
        if seeded {
            self.projection = Projection::default();
            self.seed_history(meta.len())?;
        }
        if self.offset == 0 && meta.len() > HISTORY_BYTES {
            self.offset = meta.len() - HISTORY_BYTES;
            self.line_start = self.offset;
            self.discarding = true;
            self.truncated = true;
        }
        if meta.len() == self.offset {
            return Ok(reset || seeded);
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
                    self.projection.continuity += 1;
                    self.projection.input_boundary = false;
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
            let sessions = catalog::discover(&self.root, self.selected.as_deref());
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
        if self.snapshot.session_id != id
            || selected.is_some_and(|s| {
                if s.unavailable {
                    self.tail.is_some()
                } else {
                    self.tail
                        .as_ref()
                        .is_none_or(|t| t.lineage != s.lineage || t.path != s.path)
                }
            })
        {
            self.tail = selected.filter(|s| !s.unavailable).map(Tail::from_session);
            self.snapshot.session_id = id;
            changed = true;
        }
        if let (Some(session), Some(tail)) = (selected, &mut self.tail) {
            tail.history_note = [
                session.selection_note.as_str(),
                session.history_note.as_str(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        }
        let error = if let Some(session) = selected.filter(|s| s.unavailable) {
            Some(session.selection_note.clone())
        } else if let Some(tail) = &mut self.tail {
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
                .as_mut()
                .map(|t| t.projection.model_view.build(&t.projection.events))
                .unwrap_or_default();
            self.snapshot.turn_status = self
                .tail
                .as_ref()
                .map(|t| t.projection.turn_status.clone())
                .unwrap_or_default();
            self.snapshot.notice = match &self.tail {
                None => "未找到本地 rollout JSONL；开始一轮 Codex 对话后自动发现".into(),
                Some(t) => format!(
                    "只读时间线 · 轮次为已加载记录编号{}{}{}{}{}",
                    if t.projection.events.iter().any(|e| e.model_call.is_some()) {
                        " · 模型标题前置，关联依据见详情"
                    } else {
                        " · 未关联输出不计作模型请求"
                    },
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
                    },
                    if t.history_note.is_empty() {
                        String::new()
                    } else {
                        format!(" · {}", t.history_note)
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
        let mut service = state.0.lock().map_err(|e| e.to_string())?;
        // Explicit queries remain fresh even while automatic work is paused.
        if service.tick() {
            let _ = app.emit_to("codex-tray", "runtime-snapshot", &service.snapshot);
        }
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
                if event.kind == "model" {
                    e.id != id && e.detail["modelAssociation"]["headerId"] == id
                } else {
                    e.id != id
                        && e.call_id.is_some()
                        && e.call_id == event.call_id
                        && e.turn_id == event.turn_id
                }
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
    std::thread::spawn(move || {
      let mut was_visible = false;
      loop {
        let visible = crate::tray_mode::trajectory_active(&app);
        if visible {
            let state = app.state::<RuntimeState>();
            if let Ok(mut service) = state.0.lock() {
                if !was_visible { service.scanned = None; }
                if service.tick() {
                    let _ = app.emit_to("codex-tray", "runtime-snapshot", service.snapshot.clone());
                }
            };
        }
        was_visible = visible;
        std::thread::sleep(Duration::from_millis(500));
      }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn titles_map_by_thread_id_and_follow_latest_complete_rename() {
        let id = "019a6b3c-1234-5678-9abc-0123456789ab";
        let path = PathBuf::from(format!("rollout-2026-11-09T12-30-00-{id}.jsonl"));
        assert_eq!(
            catalog::rollout_ids(&path).map(|v| v.0).as_deref(),
            Some(id)
        );
        assert_eq!(catalog::rollout_ids(Path::new("rollout-no-id.jsonl")), None);
        let mut sessions = vec![Session {
            id: "file-key".into(),
            label: "fallback".into(),
            thread_id: Some(id.into()),
            file_name: "original.jsonl".into(),
            path,
            modified: 1,
            ..Default::default()
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
        assert_eq!(p.events[1].turn_id, p.events[2].turn_id);
        assert_eq!(p.events[3].turn_number, Some(1));
        assert_eq!(p.turn_status["t1"], "completed");
        assert!(p.events[1].status.is_none()); // An output is not proof of success.
        feed(&mut p, 5, "future_item", json!({"foo":1}));
        assert_eq!(p.events.back().unwrap().kind, "record");
    }
    #[test]
    fn explicit_context_is_separate_from_unclassified_records() {
        let mut p = Projection::default();
        feed(
            &mut p,
            0,
            "world_state",
            json!({"full":true,"state":{"cwd":"D:/code"}}),
        );
        feed(
            &mut p,
            1,
            "response_item",
            json!({"type":"additional_tools","role":"developer","tools":[]}),
        );
        feed(
            &mut p,
            2,
            "response_item",
            json!({"type":"configuration_update","reasoning":{}}),
        );
        assert!(p.events.iter().all(|event| event.kind == "context"));
        assert_eq!(
            p.events[0].detail["raw"]["payload"]["state"]["cwd"],
            "D:/code"
        );
        assert_eq!(p.events[1].summary, "上下文工具更新");
        for (index, (role, kind)) in [
            ("user", "user"),
            ("assistant", "assistant"),
            ("developer", "system"),
            ("system", "system"),
            ("context", "context"),
            ("future_role", "record"),
            ("", "record"),
        ]
        .iter()
        .enumerate()
        {
            feed(
                &mut p,
                index as u64 + 3,
                "response_item",
                json!({"type":"message","role":role,"content":[{"text":"world_state context user words"}]}),
            );
            assert_eq!(&p.events.back().unwrap().kind, kind);
        }
        feed(
            &mut p,
            20,
            "event_msg",
            json!({"type":"session_settings_applied","extra":42}),
        );
        assert_eq!(p.events.back().unwrap().kind, "record");
        assert_eq!(
            p.events.back().unwrap().detail["raw"]["payload"]["extra"],
            42
        );
    }
    #[test]
    fn model_calls_require_explicit_completion_ids_and_deduplicate_mirrors() {
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
            "event_msg",
            json!({"type":"token_count", "info":{"total_token_usage":{"total_tokens":42}}}),
        );
        assert_eq!(p.events.len(), 1); // Usage totals are not an individual model call.
        feed(
            &mut p,
            2,
            "token_usage_record",
            json!({"turn_id":"t1", "response_id":"resp-a", "usage":{"total_tokens":42}}),
        );
        feed(
            &mut p,
            3,
            "event_msg",
            json!({"type":"raw_response_completed", "response_id":"resp-a", "token_usage":{"total_tokens":42}}),
        );
        assert_eq!(p.events.len(), 2);
        assert_eq!(p.events[1].model_call.as_ref().unwrap().number, 1);
        assert_eq!(
            p.events[1].model_call.as_ref().unwrap().response_id,
            "resp-a"
        );
        assert_eq!(p.events[1].status.as_deref(), Some("response_completed"));
        assert!(!p.events[1].detail["mirror"].is_null());
        feed(
            &mut p,
            4,
            "token_usage_record",
            json!({"turn_id":"t1", "response_id":"resp-b"}),
        );
        assert_eq!(p.events[2].model_call.as_ref().unwrap().number, 2);
        feed(&mut p, 5, "token_usage_record", json!({"turn_id":"t1"}));
        assert!(p.events[3].model_call.is_none());
    }
    #[test]
    fn delayed_results_keep_file_order_and_original_turn() {
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
            json!({"type":"function_call", "call_id":"c1", "name":"exec"}),
        );
        feed(
            &mut p,
            2,
            "event_msg",
            json!({"type":"task_started", "turn_id":"t2"}),
        );
        feed(
            &mut p,
            3,
            "response_item",
            json!({"type":"function_call_output", "call_id":"c1", "output":"late"}),
        );
        assert_eq!(
            p.events.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["0", "1", "2", "3"]
        );
        assert_eq!(p.events[2].turn_number, Some(2));
        assert_eq!(p.events[3].turn_number, Some(1));
        assert_eq!(p.events[3].turn_id, "t1");
    }
    #[test]
    fn turn_numbers_remain_stable_when_older_events_are_evicted() {
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
            "event_msg",
            json!({"type":"task_started", "turn_id":"t2"}),
        );
        for i in 2..(MAX_EVENTS + 10) {
            feed(&mut p, i as u64, "future_item", json!({"value":i}));
        }
        assert!(p.events.iter().all(|e| e.turn_number == Some(2)));
        assert_eq!(p.turn_numbers.len(), 1);
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
