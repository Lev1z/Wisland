use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const RUNNING_SCRIPT_NAME: &str = "wisland-codex-running.cmd";
const STATUS_SCRIPT_NAME: &str = "wisland-codex-status.ps1";
const RUNNING_SCRIPT: &str = include_str!("../../scripts/wisland-codex-running.cmd");
const STATUS_SCRIPT: &str = include_str!("../../scripts/wisland-codex-status.ps1");
const MANAGED_BEGIN: &str = "# BEGIN Wisland Codex Status Hooks";
const MANAGED_END: &str = "# END Wisland Codex Status Hooks";
const STALE_AFTER_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    phase: String,
    updated_at: u64,
    status_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedStatus {
    phase: String,
    updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstallResult {
    config_path: String,
    status_path: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn data_dir() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("wisland");
    path
}

fn status_path() -> PathBuf {
    data_dir().join("codex-status.json")
}

fn running_path() -> PathBuf {
    data_dir().join("codex-running.flag")
}

fn hold_path() -> PathBuf {
    data_dir().join("codex-running-hold.flag")
}

fn visible_running(now: u64) -> bool {
    if let Ok(metadata) = fs::metadata(running_path()) {
        if let Ok(modified) = metadata.modified() {
            let updated = modified
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            return now.saturating_sub(updated) <= STALE_AFTER_MS;
        }
    }

    if let Ok(content) = fs::read_to_string(hold_path()) {
        if content.trim().parse::<u64>().unwrap_or_default() > now {
            return true;
        }
        let _ = fs::remove_file(hold_path());
    }
    false
}

#[tauri::command]
pub fn get_codex_status() -> CodexStatus {
    let now = now_ms();
    let path = status_path();
    if visible_running(now) {
        return CodexStatus {
            phase: "running".into(),
            updated_at: now,
            status_path: path.to_string_lossy().into_owned(),
        };
    }

    let persisted = fs::read_to_string(&path)
        .ok()
        .and_then(|content| serde_json::from_str::<PersistedStatus>(&content).ok());
    match persisted {
        Some(status) if now.saturating_sub(status.updated_at) <= STALE_AFTER_MS => CodexStatus {
            phase: match status.phase.as_str() {
                "completed" | "failed" => status.phase,
                _ => "idle".into(),
            },
            updated_at: status.updated_at,
            status_path: path.to_string_lossy().into_owned(),
        },
        Some(status) => CodexStatus {
            phase: "stale".into(),
            updated_at: status.updated_at,
            status_path: path.to_string_lossy().into_owned(),
        },
        None => CodexStatus {
            phase: "idle".into(),
            updated_at: 0,
            status_path: path.to_string_lossy().into_owned(),
        },
    }
}

#[tauri::command]
pub fn clear_codex_status() -> Result<CodexStatus, String> {
    for path in [status_path(), running_path(), hold_path()] {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法清理 Codex 状态文件 {}：{error}", path.display()))?;
        }
    }
    Ok(get_codex_status())
}

fn escape_toml_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn remove_managed_block(content: &str) -> String {
    let mut output = Vec::new();
    let mut inside = false;
    for line in content.lines() {
        if line.trim() == MANAGED_BEGIN {
            inside = true;
            continue;
        }
        if inside && line.trim() == MANAGED_END {
            inside = false;
            continue;
        }
        if !inside {
            output.push(line);
        }
    }
    output.join("\n").trim_end().to_string()
}

fn write_scripts(directory: &Path) -> Result<(PathBuf, PathBuf), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建 Wisland 数据目录：{error}"))?;
    let running = directory.join(RUNNING_SCRIPT_NAME);
    let status = directory.join(STATUS_SCRIPT_NAME);
    fs::write(&running, RUNNING_SCRIPT)
        .map_err(|error| format!("无法写入 Codex 启动 hook：{error}"))?;
    fs::write(&status, STATUS_SCRIPT)
        .map_err(|error| format!("无法写入 Codex 完成 hook：{error}"))?;
    Ok((running, status))
}

#[tauri::command]
pub fn install_codex_status_hooks() -> Result<HookInstallResult, String> {
    let directory = data_dir();
    let (running_script, status_script) = write_scripts(&directory)?;
    let codex_home = dirs::home_dir()
        .ok_or_else(|| "无法定位用户目录".to_string())?
        .join(".codex");
    fs::create_dir_all(&codex_home)
        .map_err(|error| format!("无法创建 Codex 配置目录：{error}"))?;
    let config_path = codex_home.join("config.toml");
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let base = remove_managed_block(&existing);
    let running = escape_toml_basic_string(&running_script.to_string_lossy());
    let status = escape_toml_basic_string(&status_script.to_string_lossy());
    let block = format!(
        r#"{MANAGED_BEGIN}

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "cmd.exe /d /c \"{running}\""
command_windows = "cmd.exe /d /c \"{running}\""
timeout = 1
statusMessage = "Updating Wisland Codex status"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{status}\" completed"
command_windows = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{status}\" completed"
timeout = 5
statusMessage = "Updating Wisland Codex status"

{MANAGED_END}"#
    );
    let next = if base.is_empty() {
        format!("{block}\n")
    } else {
        format!("{base}\n\n{block}\n")
    };
    fs::write(&config_path, next)
        .map_err(|error| format!("无法更新 Codex 配置 {}：{error}", config_path.display()))?;

    Ok(HookInstallResult {
        config_path: config_path.to_string_lossy().into_owned(),
        status_path: status_path().to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_the_wisland_managed_block() {
        let input = format!(
            "model = \"gpt-5\"\n\n{MANAGED_BEGIN}\nold = true\n{MANAGED_END}\n\n[projects.demo]\ntrusted = true\n"
        );
        let output = remove_managed_block(&input);
        assert!(output.contains("model = \"gpt-5\""));
        assert!(output.contains("[projects.demo]"));
        assert!(!output.contains("old = true"));
    }
}
