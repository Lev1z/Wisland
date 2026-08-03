use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    file_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianEntry {
    id: String,
    kind: String,
    text: String,
    completed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Note,
    Todo,
}

impl EntryKind {
    fn heading(self) -> &'static str {
        match self {
            Self::Note => "# 记录",
            Self::Todo => "# 待办",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Todo => "todo",
        }
    }
}

fn validate_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn validate_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
}

fn safe_relative_directory(value: &str) -> Result<PathBuf, String> {
    let normalized = value.trim().replace('/', "\\");
    let path = PathBuf::from(normalized);
    if path.as_os_str().is_empty() {
        return Ok(PathBuf::new());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("每日笔记目录必须是 Vault 内的相对路径".into());
    }
    Ok(path)
}

fn daily_note_path(vault_path: &str, daily_notes_dir: &str, date: &str) -> Result<PathBuf, String> {
    let vault = Path::new(vault_path.trim());
    if !vault.is_dir() {
        return Err("请先在设置中填写有效的 Obsidian Vault 路径".into());
    }
    if !validate_date(date) {
        return Err("笔记日期格式无效".into());
    }
    Ok(vault
        .join(safe_relative_directory(daily_notes_dir)?)
        .join(format!("{date}.md")))
}

fn format_entry(time: &str, content: &str, kind: EntryKind) -> Vec<String> {
    let mut content_lines = content.lines();
    let first = content_lines.next().unwrap_or_default();
    let prefix = match kind {
        EntryKind::Note => format!("- {time}"),
        EntryKind::Todo => format!("- [ ] {time}"),
    };
    let mut lines = vec![format!("{prefix} {first}")];
    lines.extend(content_lines.map(|line| format!("  {line}")));
    lines
}

fn insert_under_heading(markdown: &str, kind: EntryKind, entry: Vec<String>) -> String {
    let mut lines: Vec<String> = if markdown.trim().is_empty() {
        Vec::new()
    } else {
        markdown.lines().map(str::to_string).collect()
    };

    let heading = kind.heading();
    let heading_index = lines.iter().position(|line| line.trim() == heading);
    if let Some(heading_index) = heading_index {
        let section_end = lines
            .iter()
            .enumerate()
            .skip(heading_index + 1)
            .find_map(|(index, line)| line.starts_with("# ").then_some(index))
            .unwrap_or(lines.len());
        let mut insert_at = section_end;
        while insert_at > heading_index + 1 && lines[insert_at - 1].trim().is_empty() {
            insert_at -= 1;
        }
        if insert_at == heading_index + 1 || !lines[insert_at - 1].trim().is_empty() {
            lines.insert(insert_at, String::new());
            insert_at += 1;
        }
        lines.splice(insert_at..insert_at, entry);
    } else {
        while lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.pop();
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(heading.to_string());
        lines.push(String::new());
        lines.extend(entry);
    }
    format!("{}\n", lines.join("\n"))
}

fn parse_entries(markdown: &str) -> Vec<ObsidianEntry> {
    let mut section: Option<EntryKind> = None;
    let mut entries = Vec::new();
    for (index, raw_line) in markdown.lines().enumerate() {
        let line = raw_line.trim_start();
        if line == EntryKind::Note.heading() {
            section = Some(EntryKind::Note);
            continue;
        }
        if line == EntryKind::Todo.heading() {
            section = Some(EntryKind::Todo);
            continue;
        }
        if line.starts_with("# ") {
            section = None;
            continue;
        }

        let Some(kind) = section else { continue };
        let parsed = match kind {
            EntryKind::Note => line
                .strip_prefix("- ")
                .filter(|text| !text.starts_with('['))
                .map(|text| (text, false)),
            EntryKind::Todo => line
                .strip_prefix("- [ ] ")
                .map(|text| (text, false))
                .or_else(|| line.strip_prefix("- [x] ").map(|text| (text, true)))
                .or_else(|| line.strip_prefix("- [X] ").map(|text| (text, true))),
        };
        if let Some((text, completed)) = parsed {
            let text = text.trim();
            if !text.is_empty() {
                entries.push(ObsidianEntry {
                    id: format!("line:{index}"),
                    kind: kind.name().to_string(),
                    text: text.to_string(),
                    completed,
                });
            }
        }
    }
    entries
}

fn read_markdown(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取每日笔记：{error}"))
}

fn write_markdown(path: &Path, markdown: &str) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory).map_err(|error| format!("无法创建每日笔记目录：{error}"))?;
    }
    fs::write(path, markdown).map_err(|error| format!("无法写入每日笔记：{error}"))
}

fn append_entry(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    time: String,
    content: String,
    kind: EntryKind,
) -> Result<SavedNote, String> {
    if !validate_time(&time) {
        return Err("笔记时间格式无效".into());
    }
    let content = content.trim();
    if content.is_empty() {
        return Err("记录内容不能为空".into());
    }
    let file_path = daily_note_path(&vault_path, &daily_notes_dir, &date)?;
    let markdown = read_markdown(&file_path)?;
    let updated = insert_under_heading(&markdown, kind, format_entry(&time, content, kind));
    write_markdown(&file_path, &updated)?;
    Ok(SavedNote {
        file_path: file_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn append_obsidian_note(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    time: String,
    content: String,
) -> Result<SavedNote, String> {
    append_entry(
        vault_path,
        daily_notes_dir,
        date,
        time,
        content,
        EntryKind::Note,
    )
}

#[tauri::command]
pub fn append_obsidian_entry(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    time: String,
    content: String,
    kind: String,
) -> Result<SavedNote, String> {
    let kind = match kind.as_str() {
        "note" => EntryKind::Note,
        "todo" => EntryKind::Todo,
        _ => return Err("记录类型无效".into()),
    };
    append_entry(vault_path, daily_notes_dir, date, time, content, kind)
}

#[tauri::command]
pub fn get_obsidian_entries(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
) -> Result<Vec<ObsidianEntry>, String> {
    let file_path = daily_note_path(&vault_path, &daily_notes_dir, &date)?;
    Ok(parse_entries(&read_markdown(&file_path)?))
}

#[tauri::command]
pub fn get_obsidian_todos(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
) -> Result<Vec<String>, String> {
    Ok(get_obsidian_entries(vault_path, daily_notes_dir, date)?
        .into_iter()
        .filter(|entry| entry.kind == "todo" && !entry.completed)
        .map(|entry| entry.text)
        .collect())
}

fn entry_line_index(id: &str) -> Result<usize, String> {
    id.strip_prefix("line:")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| "记录标识无效".to_string())
}

#[tauri::command]
pub fn set_obsidian_todo_completed(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    id: String,
    completed: bool,
) -> Result<(), String> {
    let file_path = daily_note_path(&vault_path, &daily_notes_dir, &date)?;
    let markdown = read_markdown(&file_path)?;
    let entries = parse_entries(&markdown);
    let entry = entries
        .iter()
        .find(|entry| entry.id == id && entry.kind == "todo")
        .ok_or_else(|| "待办已不存在，请刷新后重试".to_string())?;
    let index = entry_line_index(&entry.id)?;
    let mut lines: Vec<String> = markdown.lines().map(str::to_string).collect();
    let line = lines
        .get_mut(index)
        .ok_or_else(|| "待办位置无效".to_string())?;
    if completed {
        *line = line.replacen("- [ ] ", "- [x] ", 1);
    } else {
        *line = line
            .replacen("- [x] ", "- [ ] ", 1)
            .replacen("- [X] ", "- [ ] ", 1);
    }
    write_markdown(&file_path, &format!("{}\n", lines.join("\n")))
}

#[tauri::command]
pub fn delete_obsidian_entry(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    id: String,
) -> Result<(), String> {
    let file_path = daily_note_path(&vault_path, &daily_notes_dir, &date)?;
    let markdown = read_markdown(&file_path)?;
    let entries = parse_entries(&markdown);
    let entry = entries
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "记录已不存在，请刷新后重试".to_string())?;
    let index = entry_line_index(&entry.id)?;
    let mut lines: Vec<String> = markdown.lines().map(str::to_string).collect();
    let mut end = index + 1;
    while end < lines.len() && (lines[end].starts_with("  ") || lines[end].trim().is_empty()) {
        if lines[end].trim().is_empty() {
            break;
        }
        end += 1;
    }
    lines.drain(index..end);
    write_markdown(&file_path, &format!("{}\n", lines.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("wisland-{name}-{}", std::process::id()))
    }

    #[test]
    fn appends_multiline_note_under_record_heading() {
        let root = test_root("note-test");
        fs::create_dir_all(&root).unwrap();
        let result = append_obsidian_note(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
            "20:45".into(),
            "第一行\n第二行".into(),
        )
        .unwrap();
        let markdown = fs::read_to_string(result.file_path).unwrap();
        assert_eq!(markdown, "# 记录\n\n- 20:45 第一行\n  第二行\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_one_heading_and_supports_todo_updates() {
        let root = test_root("todo-test");
        fs::create_dir_all(&root).unwrap();
        for content in ["完善日记页面", "补充测试"] {
            append_obsidian_entry(
                root.to_string_lossy().into_owned(),
                "Daily".into(),
                "2026-08-02".into(),
                "21:10".into(),
                content.into(),
                "todo".into(),
            )
            .unwrap();
        }
        let entries = get_obsidian_entries(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        set_obsidian_todo_completed(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
            entries[0].id.clone(),
            true,
        )
        .unwrap();
        let todos = get_obsidian_todos(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
        )
        .unwrap();
        assert_eq!(todos, vec!["21:10 补充测试"]);
        let refreshed = get_obsidian_entries(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
        )
        .unwrap();
        delete_obsidian_entry(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
            refreshed[1].id.clone(),
        )
        .unwrap();
        assert_eq!(
            get_obsidian_entries(
                root.to_string_lossy().into_owned(),
                "Daily".into(),
                "2026-08-02".into(),
            )
            .unwrap()
            .len(),
            1
        );
        let markdown = fs::read_to_string(root.join("Daily/2026-08-02.md")).unwrap();
        assert_eq!(markdown.matches("# 待办").count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_directory_escape() {
        let root = std::env::temp_dir();
        let error = append_obsidian_note(
            root.to_string_lossy().into_owned(),
            "..\\Outside".into(),
            "2026-08-02".into(),
            "20:45".into(),
            "不能越界".into(),
        )
        .unwrap_err();
        assert!(error.contains("相对路径"));
    }
}
