use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuota {
    available: bool,
    remaining_percent: Option<f64>,
    used_percent: Option<f64>,
    window_duration_mins: Option<u64>,
    resets_at: Option<u64>,
    message: Option<String>,
}

impl CodexQuota {
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            available: false,
            remaining_percent: None,
            used_percent: None,
            window_duration_mins: None,
            resets_at: None,
            message: Some(message.into()),
        }
    }
}

fn configured_cli_path() -> Option<PathBuf> {
    std::env::var_os("WISLAND_CODEX_CLI")
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .or_else(|| {
            dirs::config_dir()
                .map(|directory| directory.join("npm").join("codex.cmd"))
                .filter(|path| path.exists())
        })
}

fn codex_command() -> Command {
    let mut command = if let Some(path) = configured_cli_path() {
        let is_script = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
            });
        if is_script {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c"]).arg(path);
            command
        } else {
            Command::new(path)
        }
    } else {
        Command::new("codex")
    };

    command.args(["app-server", "--listen", "stdio://"]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn quota_from_response(response: &Value) -> Result<CodexQuota, String> {
    if let Some(error) = response.get("error") {
        return Err(format!("Codex App Server 返回错误：{error}"));
    }
    let result = response
        .get("result")
        .ok_or_else(|| "Codex App Server 响应缺少 result".to_string())?;
    let rate_limit = result
        .get("rateLimits")
        .filter(|value| value.is_object())
        .or_else(|| {
            result
                .get("rateLimitsByLimitId")
                .and_then(|value| value.get("codex"))
                .filter(|value| value.is_object())
        })
        .ok_or_else(|| "当前 Codex 登录方式未返回额度窗口".to_string())?;

    let selected = [rate_limit.get("primary"), rate_limit.get("secondary")]
        .into_iter()
        .flatten()
        .filter(|value| value.is_object())
        .filter_map(|value| {
            value
                .get("usedPercent")
                .and_then(Value::as_f64)
                .map(|used| (value, used))
        })
        .max_by(|left, right| left.1.total_cmp(&right.1))
        .ok_or_else(|| "Codex 额度响应中没有可用窗口".to_string())?;

    let used_percent = selected.1.clamp(0.0, 100.0);
    Ok(CodexQuota {
        available: true,
        remaining_percent: Some(100.0 - used_percent),
        used_percent: Some(used_percent),
        window_duration_mins: selected.0.get("windowDurationMins").and_then(Value::as_u64),
        resets_at: selected.0.get("resetsAt").and_then(Value::as_u64),
        message: None,
    })
}

async fn query_codex_quota() -> Result<CodexQuota, String> {
    let mut child = codex_command()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法启动独立 Codex CLI：{error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Codex App Server 输入流".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Codex App Server 输出流".to_string())?;

    let requests = concat!(
        "{\"method\":\"initialize\",\"id\":1,\"params\":{\"clientInfo\":{\"name\":\"wisland\",\"title\":\"Wisland\",\"version\":\"0.1.0\"}}}\n",
        "{\"method\":\"initialized\",\"params\":{}}\n",
        "{\"method\":\"account/rateLimits/read\",\"id\":2}\n"
    );
    stdin
        .write_all(requests.as_bytes())
        .await
        .map_err(|error| format!("写入 Codex App Server 失败：{error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("刷新 Codex App Server 请求失败：{error}"))?;

    let read_response = async {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = reader
                .read_line(&mut line)
                .await
                .map_err(|error| format!("读取 Codex App Server 失败：{error}"))?;
            if bytes == 0 {
                return Err("Codex App Server 在返回额度前退出".to_string());
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("id").and_then(Value::as_u64) == Some(2) {
                return quota_from_response(&value);
            }
        }
    };

    let result = timeout(QUERY_TIMEOUT, read_response)
        .await
        .map_err(|_| "Codex 额度查询超时".to_string())?;
    let _ = child.kill().await;
    result
}

#[tauri::command]
pub async fn get_codex_quota() -> CodexQuota {
    query_codex_quota()
        .await
        .unwrap_or_else(CodexQuota::unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_most_constrained_rate_limit_window() {
        let response = serde_json::json!({
            "id": 2,
            "result": {
                "rateLimits": {
                    "primary": { "usedPercent": 25.0, "windowDurationMins": 300, "resetsAt": 100 },
                    "secondary": { "usedPercent": 60.0, "windowDurationMins": 10080, "resetsAt": 200 }
                }
            }
        });
        let quota = quota_from_response(&response).unwrap();
        assert_eq!(quota.remaining_percent, Some(40.0));
        assert_eq!(quota.window_duration_mins, Some(10080));
    }
}
