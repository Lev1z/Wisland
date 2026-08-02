use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNote {
    file_path: String,
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

#[tauri::command]
pub fn append_obsidian_note(
    vault_path: String,
    daily_notes_dir: String,
    date: String,
    time: String,
    content: String,
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
    writeln!(file, "- {time} {first}").map_err(|error| format!("无法写入随手记：{error}"))?;
    for line in lines {
        writeln!(file, "  {line}").map_err(|error| format!("无法写入随手记：{error}"))?;
    }

    Ok(SavedNote {
        file_path: file_path.to_string_lossy().into_owned(),
    })
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
}
