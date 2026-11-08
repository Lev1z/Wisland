//! Logical threads, selected rollouts and immutable history references. Read-only.
use super::{resolve_session_names, short, LINE_BYTES};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct HistoryEnd {
    pub rollout_id: String,
    pub bytes: u64,
    pub ordinal: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Segment {
    pub path: PathBuf,
    pub rollout_id: String,
    pub end: Option<HistoryEnd>,
}

#[derive(Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Session {
    pub id: String,
    pub label: String,
    pub thread_id: Option<String>,
    pub file_name: String,
    pub modified: u64,
    pub forked_from_id: Option<String>,
    pub parent_label: Option<String>,
    pub rollout_count: usize,
    pub selection_note: String,
    pub unavailable: bool,
    #[serde(skip)]
    pub path: PathBuf,
    #[serde(skip)]
    pub lineage: Vec<Segment>,
    #[serde(skip)]
    pub history_note: String,
}

#[derive(Clone)]
struct Rollout {
    thread_id: String,
    rollout_id: String,
    path: PathBuf,
    modified: u64,
    archived: bool,
    forked_from: Option<String>,
    base: Option<HistoryEnd>,
    metadata_ok: bool,
}

fn uuid(s: &str) -> Option<String> {
    (s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        }))
    .then(|| s.to_ascii_lowercase())
}

// Codex rollout_file_name.rs: stable thread UUID, optionally followed by a
// distinct immutable rollout UUID after revert. Never use the last UUID as title key.
pub(super) fn rollout_ids(path: &Path) -> Option<(String, String)> {
    let core = path
        .file_name()?
        .to_str()?
        .strip_prefix("rollout-")?
        .strip_suffix(".jsonl")?;
    let timestamp = core.get(..19)?;
    if !timestamp.bytes().enumerate().all(|(i, b)| match i {
        4 | 7 | 13 | 16 => b == b'-',
        10 => b == b'T',
        _ => b.is_ascii_digit(),
    }) || core.get(19..20)? != "-"
    {
        return None;
    }
    let ids = core.get(20..)?;
    let (thread, rollout) = ids.split_once('_').unwrap_or((ids, ids));
    Some((uuid(thread)?, uuid(rollout)?))
}

fn metadata(path: &Path) -> Option<Value> {
    let file = File::open(path).ok()?;
    let mut line = Vec::new();
    BufReader::new(file.take(LINE_BYTES as u64 + 1))
        .read_until(b'\n', &mut line)
        .ok()?;
    if line.len() > LINE_BYTES || line.last() != Some(&b'\n') {
        return None;
    }
    let record: Value = serde_json::from_slice(&line).ok()?;
    (record["type"] == "session_meta").then(|| record["payload"].clone())
}

fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn scan(root: &Path, archived: bool, result: &mut Vec<Rollout>) {
    let mut dirs = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if reparse(&meta) {
                continue;
            }
            let path = entry.path();
            if meta.is_dir() && depth < 3 {
                dirs.push((path, depth + 1));
            } else if meta.is_file() {
                let Some((file_thread, rollout_id)) = rollout_ids(&path) else {
                    continue;
                };
                let head = metadata(&path);
                let thread_id = head
                    .as_ref()
                    .and_then(|p| p["id"].as_str())
                    .and_then(uuid)
                    .unwrap_or(file_thread);
                let forked_from = head
                    .as_ref()
                    .and_then(|p| p["forked_from_id"].as_str())
                    .and_then(uuid);
                let base = head.as_ref().and_then(|p| {
                    let base = &p["history_base"];
                    Some(HistoryEnd {
                        rollout_id: uuid(base["thread_id"].as_str()?)?,
                        bytes: base["end_byte_offset"].as_u64()?,
                        ordinal: base["end_ordinal_exclusive"].as_u64()?,
                    })
                });
                let metadata_ok = head
                    .as_ref()
                    .is_some_and(|p| p["history_base"].is_null() || base.is_some());
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|v| v.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                result.push(Rollout {
                    thread_id,
                    rollout_id,
                    path,
                    modified,
                    archived,
                    forked_from,
                    base,
                    metadata_ok,
                });
            }
        }
    }
}

fn state_db(home: &Path) -> Option<Connection> {
    let mut paths: Vec<_> = fs::read_dir(home)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let meta = fs::symlink_metadata(entry.path()).ok()?;
            if !meta.is_file() || reparse(&meta) {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, entry.path()))
        })
        .collect();
    paths.sort_by(|a, b| b.0.cmp(&a.0));
    let db = Connection::open_with_flags(
        &paths.first()?.1,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    db.busy_timeout(Duration::from_millis(50)).ok()?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .ok()?;
    Some(db)
}

#[derive(Default)]
struct DbThread {
    path: String,
    name: Option<String>,
    archived: bool,
}

fn db_threads(home: &Path, ids: impl Iterator<Item = String>) -> HashMap<String, DbThread> {
    let Some(db) = state_db(home) else {
        return HashMap::new();
    };
    // `name` was added after `title` (the latter can be a first user message).
    // Unknown schemas or locked/missing databases gracefully fall back to JSONL.
    let sql = if db.prepare("SELECT name FROM threads LIMIT 0").is_ok() {
        "SELECT rollout_path, name, archived FROM threads WHERE id=?1"
    } else {
        "SELECT rollout_path, NULL, archived FROM threads WHERE id=?1"
    };
    let Ok(mut stmt) = db.prepare(sql) else {
        return HashMap::new();
    };
    ids.filter_map(|id| {
        stmt.query_row([&id], |row| {
            Ok(DbThread {
                path: row.get(0)?,
                name: row.get(1)?,
                archived: row.get::<_, i64>(2)? != 0,
            })
        })
        .ok()
        .map(|row| (id, row))
    })
    .collect()
}

fn path_key(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        s.trim_start_matches("\\\\?\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

fn lineage(current: &Rollout, rollouts: &[Rollout]) -> (Vec<Segment>, String) {
    let mut segments = Vec::new();
    let mut seen = HashSet::new();
    let mut item = current;
    let mut end: Option<HistoryEnd> = None;
    let mut note = String::new();
    loop {
        if segments.len() >= 64 || !seen.insert(item.rollout_id.clone()) {
            note = "历史引用循环或过深，仅显示可确认的后续日志".into();
            break;
        }
        if let Some(cutoff) = &end {
            if cutoff.ordinal == 0
                || cutoff.bytes == 0
                || fs::metadata(&item.path).map_or(true, |m| cutoff.bytes > m.len())
            {
                note = "历史引用边界无效，仅显示可确认的后续日志".into();
                break;
            }
        }
        segments.push(Segment {
            path: item.path.clone(),
            rollout_id: item.rollout_id.clone(),
            end: end.clone(),
        });
        if !item.metadata_ok {
            note = "日志元数据尚不可读，历史引用未确认".into();
            break;
        }
        let Some(base) = &item.base else {
            break;
        };
        let Some(parent) = rollouts.iter().find(|r| r.rollout_id == base.rollout_id) else {
            note = "历史源日志缺失或已压缩，仅显示本地可读部分".into();
            break;
        };
        end = Some(base.clone());
        item = parent;
    }
    segments.reverse();
    (segments, note)
}

pub(super) fn discover(root: &Path, pinned: Option<&str>) -> Vec<Session> {
    let mut rollouts = Vec::new();
    scan(root, false, &mut rollouts);
    if let Some(home) = root.parent() {
        scan(&home.join("archived_sessions"), true, &mut rollouts);
    }
    let mut groups: HashMap<String, Vec<&Rollout>> = HashMap::new();
    for rollout in &rollouts {
        if !rollout.archived {
            groups
                .entry(rollout.thread_id.clone())
                .or_default()
                .push(rollout);
        }
    }
    let db = root
        .parent()
        .map(|home| db_threads(home, groups.keys().cloned()))
        .unwrap_or_default();
    let mut sessions = Vec::new();
    for (id, mut candidates) in groups {
        let indexed = db.get(&id);
        if indexed.is_some_and(|r| r.archived) {
            continue;
        }
        // File creation timestamp + immutable UUID are stable even if an obsolete
        // file is touched. SQLite's selected path wins over this fallback.
        candidates.sort_by(|a, b| b.path.file_name().cmp(&a.path.file_name()));
        let matched = indexed.and_then(|row| {
            candidates
                .iter()
                .find(|r| path_key(&r.path) == path_key(Path::new(&row.path)))
                .copied()
        });
        let current = matched.unwrap_or(candidates[0]);
        let unavailable = indexed.is_some() && matched.is_none();
        let selection_note = if unavailable {
            "索引指定的当前日志不在本地可读列表中，未用旧日志替代".into()
        } else if indexed.is_none() && candidates.len() > 1 {
            "无可读当前日志索引，暂按日志创建顺序选择".into()
        } else {
            String::new()
        };
        let (lineage, history_note) = lineage(current, &rollouts);
        sessions.push(Session {
            id: id.clone(),
            thread_id: Some(id),
            label: "未命名会话".into(),
            file_name: current
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: current.path.clone(),
            modified: current.modified,
            forked_from_id: current.forked_from.clone(),
            parent_label: None,
            rollout_count: candidates.len(),
            selection_note,
            unavailable,
            lineage,
            history_note,
        });
    }
    resolve_session_names(root, &mut sessions);
    for session in &mut sessions {
        if let Some(name) = db
            .get(&session.id)
            .and_then(|row| row.name.as_deref())
            .filter(|n| !n.trim().is_empty())
        {
            session.label = short(name.trim(), 240);
        }
    }
    let names: HashMap<_, _> = sessions
        .iter()
        .map(|s| (s.id.clone(), s.label.clone()))
        .collect();
    for session in &mut sessions {
        session.parent_label = session
            .forked_from_id
            .as_ref()
            .and_then(|id| names.get(id))
            .cloned();
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.id.cmp(&b.id)));
    let pinned_old = sessions
        .iter()
        .skip(40)
        .find(|s| Some(s.id.as_str()) == pinned)
        .cloned();
    sessions.truncate(40);
    if let Some(old) = pinned_old {
        sessions.push(old);
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::super::{Service, Snapshot, Tail};
    use super::*;
    const THREAD: &str = "019a6b3c-1234-5678-9abc-0123456789ab";
    const ROLL: &str = "019a6b3c-1234-5678-9abc-0123456789ac";
    const FORK: &str = "019a6b3c-1234-5678-9abc-0123456789ad";
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wisland-catalog-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(path.join("sessions")).unwrap();
            Self(path)
        }
        fn root(&self) -> PathBuf {
            self.0.join("sessions")
        }
        fn write(
            &self,
            id: &str,
            roll: Option<&str>,
            fork: Option<&str>,
            base: Value,
            events: &str,
        ) -> PathBuf {
            let path = self.root().join(format!(
                "rollout-2026-11-09T12-30-00-{id}{}.jsonl",
                roll.map(|r| format!("_{r}")).unwrap_or_default()
            ));
            let head = serde_json::json!({"type":"session_meta","payload":{"id":id,"forked_from_id":fork,"history_mode":"paginated","history_base":base}});
            fs::write(&path, format!("{head}\n{events}")).unwrap();
            path
        }
        fn index(&self, ids: &[&str]) {
            fs::write(
                self.0.join("session_index.jsonl"),
                ids.iter()
                    .map(|id| format!("{{\"id\":\"{id}\",\"thread_name\":\"同名会话\"}}\n"))
                    .collect::<String>(),
            )
            .unwrap();
        }
        fn db(&self, id: &str, path: &Path) -> Connection {
            let db = Connection::open(self.0.join("state_5.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, name TEXT, archived INTEGER DEFAULT 0);").unwrap();
            db.execute(
                "INSERT INTO threads (id,rollout_path,name) VALUES (?1,?2,?3)",
                [id, path.to_str().unwrap(), "数据库会话名"],
            )
            .unwrap();
            db
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn event(message: &str, ordinal: u64) -> String {
        format!("{{\"ordinal\":{ordinal},\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{message}\"}}}}\n")
    }

    #[test]
    fn parses_both_filename_generations_and_rejects_false_suffixes() {
        assert_eq!(
            rollout_ids(Path::new(&format!(
                "rollout-2026-11-09T12-30-00-{THREAD}_{ROLL}.jsonl"
            ))),
            Some((THREAD.into(), ROLL.into()))
        );
        for name in [
            format!("wrong-{THREAD}.jsonl"),
            format!("rollout-bad-date-{THREAD}.jsonl"),
            format!("rollout-2026-11-09T12-30-00-{THREAD}_{ROLL}_extra.jsonl"),
        ] {
            assert!(rollout_ids(Path::new(&name)).is_none());
        }
    }
    #[test]
    fn deduplicates_rollouts_not_named_threads_and_keeps_real_forks() {
        let f = Fixture::new();
        f.write(THREAD, None, None, Value::Null, "");
        f.write(THREAD, Some(ROLL), None, Value::Null, "");
        f.write(FORK, None, Some(THREAD), Value::Null, "");
        f.index(&[THREAD, FORK]);
        let sessions = discover(&f.root(), None);
        assert_eq!(sessions.len(), 2);
        let root = sessions.iter().find(|s| s.id == THREAD).unwrap();
        assert_eq!(root.rollout_count, 2);
        assert_eq!(root.label, "同名会话");
        assert!(root.file_name.contains(ROLL));
        assert!(!root.selection_note.is_empty());
        let fork = sessions.iter().find(|s| s.id == FORK).unwrap();
        assert_eq!(fork.forked_from_id.as_deref(), Some(THREAD));
        assert_eq!(fork.parent_label.as_deref(), Some("同名会话"));
    }
    #[test]
    fn sqlite_selected_path_wins_and_only_reads_existing_index() {
        let f = Fixture::new();
        let old = f.write(THREAD, None, None, Value::Null, "");
        f.write(THREAD, Some(ROLL), None, Value::Null, "");
        f.index(&[THREAD]);
        let db = f.db(THREAD, &old);
        db.execute_batch("PRAGMA journal_mode=WAL; UPDATE threads SET name='数据库会话名';")
            .unwrap();
        let before = fs::read(f.0.join("state_5.sqlite")).unwrap();
        let sessions = discover(&f.root(), None);
        assert_eq!(sessions[0].path, old);
        assert_eq!(sessions[0].label, "数据库会话名");
        assert_eq!(fs::read(f.0.join("state_5.sqlite")).unwrap(), before);
        assert!(sessions[0].selection_note.is_empty());
    }
    #[test]
    fn missing_or_external_selected_path_never_substitutes_obsolete_log() {
        let f = Fixture::new();
        f.write(THREAD, None, None, Value::Null, "");
        let db = f.db(THREAD, &f.0.join("outside.jsonl"));
        drop(db);
        let sessions = discover(&f.root(), None);
        assert!(sessions[0].unavailable);
        let mut service = Service {
            root: f.root(),
            selected: None,
            tail: None,
            snapshot: Snapshot::default(),
            scanned: None,
        };
        service.tick();
        assert!(service.tail.is_none());
        assert!(service.snapshot.error.is_some());
    }
    #[test]
    fn follows_rollout_not_thread_reference_and_honors_cutoffs() {
        let f = Fixture::new();
        let root = f.write(THREAD, None, None, Value::Null, &event("retained", 1));
        let cutoff = fs::metadata(&root).unwrap().len();
        use std::io::Write;
        File::options()
            .append(true)
            .open(&root)
            .unwrap()
            .write_all(event("abandoned", 2).as_bytes())
            .unwrap();
        let base = serde_json::json!({"thread_id":THREAD,"end_byte_offset":cutoff,"end_ordinal_exclusive":2});
        let second = f.write(THREAD, Some(ROLL), None, base, &event("replacement", 3));
        let fork_base = serde_json::json!({"thread_id":ROLL,"end_byte_offset":fs::metadata(&second).unwrap().len(),"end_ordinal_exclusive":4});
        f.write(FORK, None, Some(THREAD), fork_base, &event("fork", 5));
        let sessions = discover(&f.root(), None);
        let session = sessions.iter().find(|s| s.id == FORK).unwrap();
        assert_eq!(session.lineage.len(), 3);
        let mut tail = Tail::from_session(session);
        tail.poll().unwrap();
        assert_eq!(
            tail.projection
                .events
                .iter()
                .map(|e| e.summary.as_str())
                .collect::<Vec<_>>(),
            ["retained", "replacement", "fork"]
        );
        let ids: HashSet<_> = tail
            .projection
            .events
            .iter()
            .map(|e| e.id.clone())
            .collect();
        assert_eq!(ids.len(), 3);
        assert!(tail.projection.events[0].id.starts_with(THREAD));
        assert!(tail.projection.events[1].id.starts_with(ROLL));
    }
    #[test]
    fn handles_missing_history_cycles_and_invalid_cutoffs_with_notice() {
        let f = Fixture::new();
        f.write(
            THREAD,
            Some(ROLL),
            None,
            serde_json::json!({"thread_id":FORK,"end_byte_offset":10,"end_ordinal_exclusive":1}),
            "",
        );
        assert!(discover(&f.root(), None)[0].history_note.contains("缺失"));
        f.write(
            THREAD,
            Some(ROLL),
            None,
            serde_json::json!({"thread_id":ROLL,"end_byte_offset":10,"end_ordinal_exclusive":1}),
            "",
        );
        assert!(discover(&f.root(), None)[0].history_note.contains("循环"));
        f.write(FORK, None, None, Value::Null, "");
        f.write(THREAD, Some(ROLL), None, serde_json::json!({"thread_id":FORK,"end_byte_offset":9999999,"end_ordinal_exclusive":1}), "");
        assert!(discover(&f.root(), None)
            .iter()
            .find(|s| s.id == THREAD)
            .unwrap()
            .history_note
            .contains("边界无效"));
    }
    #[test]
    fn pinned_thread_reloads_when_current_rollout_changes() {
        let f = Fixture::new();
        let old = f.write(THREAD, None, None, Value::Null, &event("old", 1));
        let new = f.write(THREAD, Some(ROLL), None, Value::Null, &event("new", 1));
        let db = f.db(THREAD, &old);
        let mut service = Service {
            root: f.root(),
            selected: Some(THREAD.into()),
            tail: None,
            snapshot: Snapshot::default(),
            scanned: None,
        };
        service.tick();
        assert_eq!(service.snapshot.events[0].summary, "old");
        db.execute(
            "UPDATE threads SET rollout_path=?1 WHERE id=?2",
            [new.to_str().unwrap(), THREAD],
        )
        .unwrap();
        service.scanned = None;
        service.tick();
        assert_eq!(service.snapshot.session_id.as_deref(), Some(THREAD));
        assert_eq!(service.snapshot.events[0].summary, "new");
    }
    #[test]
    fn aggregate_history_budget_is_bounded_and_archived_bases_are_readable() {
        let f = Fixture::new();
        let content = format!(
            "{}\n{}",
            " ".repeat(super::super::HISTORY_BYTES as usize),
            event("tail of archive", 1)
        );
        let root = f.write(THREAD, None, None, Value::Null, &content);
        let cutoff = fs::metadata(&root).unwrap().len();
        fs::create_dir(f.0.join("archived_sessions")).unwrap();
        fs::rename(
            &root,
            f.0.join("archived_sessions")
                .join(root.file_name().unwrap()),
        )
        .unwrap();
        f.write(FORK, None, Some(THREAD),serde_json::json!({"thread_id":THREAD,"end_byte_offset":cutoff,"end_ordinal_exclusive":2}), &event("leaf",3));
        let sessions = discover(&f.root(), None);
        assert_eq!(sessions.len(), 1);
        let mut tail = Tail::from_session(&sessions[0]);
        tail.poll().unwrap();
        assert!(tail.truncated);
        assert_eq!(tail.projection.events.len(), 2);
    }

    #[test]
    #[ignore = "read-only local audit; set WISLAND_RUNTIME_AUDIT_HOME explicitly"]
    fn audit_local_catalog() {
        let home = PathBuf::from(
            std::env::var_os("WISLAND_RUNTIME_AUDIT_HOME").expect("explicit audit home"),
        );
        let sessions = discover(&home.join("sessions"), None);
        let unique: HashSet<_> = sessions.iter().map(|s| &s.id).collect();
        assert_eq!(unique.len(), sessions.len());
        println!(
            "logical_threads={} named={} forks={} unavailable={} fallback={} physical_rollouts={}",
            sessions.len(),
            sessions.iter().filter(|s| s.label != "未命名会话").count(),
            sessions
                .iter()
                .filter(|s| s.forked_from_id.is_some())
                .count(),
            sessions.iter().filter(|s| s.unavailable).count(),
            sessions
                .iter()
                .filter(|s| !s.selection_note.is_empty())
                .count(),
            sessions.iter().map(|s| s.rollout_count).sum::<usize>()
        );
        println!(
            "referenced_histories={} incomplete_histories={}",
            sessions.iter().filter(|s| s.lineage.len() > 1).count(),
            sessions
                .iter()
                .filter(|s| !s.history_note.is_empty())
                .count()
        );
        let mut notes = std::collections::BTreeMap::new();
        for s in &sessions { if !s.history_note.is_empty() { *notes.entry(&s.history_note).or_insert(0) += 1; } }
        println!("history_notices={notes:?}");
    }
}
