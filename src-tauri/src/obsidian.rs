use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    file_path: String,
}

#[derive(Clone, Copy)]
enum EntryKind {
    Note,
    Todo,
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

fn append_entry(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    time: String,
    content: String,
    kind: EntryKind,
) -> Result<SavedNote, String> {
    let vault = Path::new(vault_path.trim());
    if !vault.is_dir() {
        return Err("请先在设置中填写有效的 Obsidian Vault 路径".into());
    }
    if !validate_date(&date) {
        return Err("笔记日期格式无效".into());
    }
    if !validate_time(&time) {
        return Err("笔记时间格式无效".into());
    }
    let content = content.trim();
    if content.is_empty() {
        return Err("随手记内容不能为空".into());
    }

    let directory = vault.join(safe_relative_directory(&daily_notes_dir)?);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建每日笔记目录：{error}"))?;
    let file_path = directory.join(format!("{date}.md"));
    let is_new = fs::metadata(&file_path).map(|metadata| metadata.len() == 0).unwrap_or(true);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|error| format!("无法打开每日笔记：{error}"))?;

    if is_new {
        writeln!(file, "# {date}\n").map_err(|error| format!("无法写入笔记标题：{error}"))?;
    }
    let mut lines = content.lines();
    let first = lines.next().unwrap_or_default();
    let prefix = match kind {
        EntryKind::Note => format!("- {time}"),
        EntryKind::Todo => format!("- [ ] {time}"),
    };
    writeln!(file, "{prefix} {first}").map_err(|error| format!("无法写入随手记：{error}"))?;
    for line in lines {
        writeln!(file, "  {line}").map_err(|error| format!("无法写入随手记：{error}"))?;
    }

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
    append_entry(vault_path, daily_notes_dir, date, time, content, EntryKind::Note)
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
pub fn get_obsidian_todos(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
) -> Result<Vec<String>, String> {
    let vault = Path::new(vault_path.trim());
    if !vault.is_dir() {
        return Err("请先在设置中填写有效的 Obsidian Vault 路径".into());
    }
    if !validate_date(&date) {
        return Err("笔记日期格式无效".into());
    }
    let file_path = vault
        .join(safe_relative_directory(&daily_notes_dir)?)
        .join(format!("{date}.md"));
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let markdown = fs::read_to_string(&file_path)
        .map_err(|error| format!("无法读取每日笔记：{error}"))?;
    Ok(markdown
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("- [ ] "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_multiline_note_to_daily_markdown() {
        let root = std::env::temp_dir().join(format!("wisland-note-test-{}", std::process::id()));
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
        assert_eq!(markdown, "# 2026-08-02\n\n- 20:45 第一行\n  第二行\n");

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

    #[test]
    fn appends_and_reads_open_todos() {
        let root = std::env::temp_dir().join(format!("wisland-todo-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();

        append_obsidian_entry(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
            "21:10".into(),
            "完善日记页面".into(),
            "todo".into(),
        )
        .unwrap();
        let todos = get_obsidian_todos(
            root.to_string_lossy().into_owned(),
            "Daily".into(),
            "2026-08-02".into(),
        )
        .unwrap();
        assert_eq!(todos, vec!["21:10 完善日记页面"]);

        fs::remove_dir_all(root).unwrap();
    }
}
