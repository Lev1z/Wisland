use serde::Serialize;
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_CONSOLE: u32 = 0x00000010;
const QUERY_TIMEOUT: Duration = Duration::from_secs(8);
const LOGIN_STATUS_TIMEOUT: Duration = Duration::from_secs(8);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const RETRY_DELAY: Duration = Duration::from_millis(650);

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    available: bool,
    path: Option<String>,
    source: Option<String>,
    npm_available: bool,
    npm_path: Option<String>,
    authenticated: Option<bool>,
    message: String,
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

fn path_cli() -> Option<PathBuf> {
    path_command(&["codex.exe", "codex.cmd", "codex.bat"])
}

fn path_command(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|directory| {
        names
            .iter()
            .map(|name| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn configured_npm_path() -> Option<PathBuf> {
    path_command(&["npm.cmd", "npm.exe", "npm.bat"]).or_else(|| {
        std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .map(|directory| directory.join("nodejs").join("npm.cmd"))
            .filter(|path| path.is_file())
    })
}

fn configured_node_path() -> Option<PathBuf> {
    path_command(&["node.exe"]).or_else(|| {
        ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .flat_map(|directory| {
                [
                    directory.join("nodejs").join("node.exe"),
                    directory.join("Programs").join("nodejs").join("node.exe"),
                ]
            })
            .find(|path| path.is_file())
    })
}

fn augmented_command_path(executable: &Path) -> Option<OsString> {
    let mut directories = Vec::<PathBuf>::new();
    let mut push_unique = |directory: PathBuf| {
        if !directories.iter().any(|existing| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&directory.to_string_lossy())
        }) {
            directories.push(directory);
        }
    };

    if let Some(directory) = executable.parent() {
        push_unique(directory.to_path_buf());
    }
    if let Some(directory) =
        configured_node_path().and_then(|path| path.parent().map(Path::to_path_buf))
    {
        push_unique(directory);
    }
    if let Some(directory) =
        configured_npm_path().and_then(|path| path.parent().map(Path::to_path_buf))
    {
        push_unique(directory);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            push_unique(directory);
        }
    }
    std::env::join_paths(directories).ok()
}

fn configured_cli_path() -> Option<(PathBuf, &'static str)> {
    std::env::var_os("WISLAND_CODEX_CLI")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .map(|path| (path, "WISLAND_CODEX_CLI"))
        .or_else(|| {
            dirs::config_dir()
                .map(|directory| directory.join("npm").join("codex.cmd"))
                .filter(|path| path.is_file())
                .map(|path| (path, "npm 全局安装"))
        })
        .or_else(|| path_cli().map(|path| (path, "PATH")))
}

fn is_command_script(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
}

fn command_for_path(path: &Path) -> Command {
    let mut command = {
        if is_command_script(path) {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c"]).arg(path);
            command
        } else {
            Command::new(path)
        }
    };
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    if let Some(path_env) = augmented_command_path(path) {
        command.env("PATH", path_env);
    }
    command
}

fn codex_command() -> Result<Command, String> {
    let (path, _) = configured_cli_path()
        .ok_or_else(|| "未找到独立 Codex CLI；请先安装 CLI，再连接额度服务".to_string())?;
    let mut command = command_for_path(&path);
    command.args(["app-server", "--listen", "stdio://"]);
    Ok(command)
}

async fn login_status(path: &Path) -> Option<bool> {
    let mut command = command_for_path(path);
    command
        .args(["login", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    timeout(LOGIN_STATUS_TIMEOUT, command.status())
        .await
        .ok()
        .and_then(Result::ok)
        .map(|status| status.success())
}

async fn codex_cli_status() -> CodexCliStatus {
    let npm_path = configured_npm_path();
    match configured_cli_path() {
        Some((path, source)) => CodexCliStatus {
            available: true,
            path: Some(path.to_string_lossy().to_string()),
            source: Some(source.to_string()),
            npm_available: npm_path.is_some(),
            npm_path: npm_path.map(|path| path.to_string_lossy().to_string()),
            authenticated: login_status(&path).await,
            message: "已找到独立 Codex CLI".to_string(),
        },
        None => CodexCliStatus {
            available: false,
            path: None,
            source: None,
            npm_available: npm_path.is_some(),
            npm_path: npm_path.map(|path| path.to_string_lossy().to_string()),
            authenticated: None,
            message: if configured_npm_path().is_some() {
                "未找到独立 Codex CLI；已检测到 npm，可直接安装".to_string()
            } else {
                "未找到 Codex CLI 和 npm；请先安装 Node.js LTS".to_string()
            },
        },
    }
}

#[tauri::command]
pub async fn get_codex_cli_status() -> CodexCliStatus {
    codex_cli_status().await
}

fn compact_command_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout);
    let stderr = String::from_utf8_lossy(stderr);
    let combined = format!("{stderr}\n{stdout}");
    let mut lines: Vec<&str> = combined
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(4)
        .collect();
    lines.reverse();
    let summary = lines.join(" · ");
    if summary.is_empty() {
        "命令未返回错误详情".to_string()
    } else {
        summary.chars().take(500).collect()
    }
}

#[tauri::command]
pub async fn install_codex_cli() -> Result<CodexCliStatus, String> {
    if configured_cli_path().is_some() {
        return Ok(codex_cli_status().await);
    }
    let npm_path = configured_npm_path()
        .ok_or_else(|| "没有检测到 npm；请先安装 Node.js LTS，再返回重新检测".to_string())?;
    let mut command = command_for_path(&npm_path);
    command
        .args(["install", "--global", "@openai/codex"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| "安装 Codex CLI 超时，请检查网络后重试".to_string())?
        .map_err(|error| format!("无法启动 npm：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Codex CLI 安装失败：{}",
            compact_command_output(&output.stdout, &output.stderr)
        ));
    }
    let status = codex_cli_status().await;
    if !status.available {
        return Err(
            "npm 已完成安装，但 Wisland 尚未找到 Codex CLI；请重新启动 Wisland 后检测".to_string(),
        );
    }
    Ok(status)
}

#[tauri::command]
pub async fn start_codex_login() -> Result<(), String> {
    let (path, _) = configured_cli_path().ok_or_else(|| "尚未安装 Codex CLI".to_string())?;
    let mut preflight = command_for_path(&path);
    preflight
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(LOGIN_STATUS_TIMEOUT, preflight.output())
        .await
        .map_err(|_| "Codex CLI 启动检查超时；请重新启动 Wisland 后重试".to_string())?
        .map_err(|error| format!("无法启动 Codex CLI：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Codex CLI 无法运行：{}",
            compact_command_output(&output.stdout, &output.stderr)
        ));
    }

    let mut command = command_for_path(&path);
    command.arg("login").stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NEW_CONSOLE);
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动 Codex 登录：{error}"))
}

#[tauri::command]
pub fn open_nodejs_download() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://nodejs.org/en/download")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 Node.js 下载页面：{error}"))
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
    let mut child = codex_command()?
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

    let exchange = async {
        let mut reader = BufReader::new(stdout);
        stdin
            .write_all(b"{\"method\":\"initialize\",\"id\":1,\"params\":{\"clientInfo\":{\"name\":\"wisland\",\"title\":\"Wisland\",\"version\":\"0.1.3\"}}}\n")
            .await
            .map_err(|error| format!("写入 Codex App Server 初始化请求失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex App Server 初始化请求失败：{error}"))?;

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
            if value.get("id").and_then(Value::as_u64) == Some(1) {
                if let Some(error) = value.get("error") {
                    return Err(format!("Codex App Server 初始化失败：{error}"));
                }
                break;
            }
        }

        stdin
            .write_all(
                concat!(
                    "{\"method\":\"initialized\",\"params\":{}}\n",
                    "{\"method\":\"account/rateLimits/read\",\"id\":2}\n"
                )
                .as_bytes(),
            )
            .await
            .map_err(|error| format!("写入 Codex App Server 额度请求失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex App Server 额度请求失败：{error}"))?;

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

    let result = timeout(QUERY_TIMEOUT, exchange)
        .await
        .map_err(|_| "Codex 额度查询超时".to_string())?;
    let _ = child.kill().await;
    result
}

fn retryable(error: &str) -> bool {
    !error.contains("未找到独立 Codex CLI") && !error.contains("无法启动独立 Codex CLI")
}

async fn query_codex_quota_with_retry() -> Result<CodexQuota, String> {
    match query_codex_quota().await {
        Ok(quota) => Ok(quota),
        Err(first_error) if retryable(&first_error) => {
            tokio::time::sleep(RETRY_DELAY).await;
            query_codex_quota().await.map_err(|second_error| {
                format!("{second_error}（已自动重试；首次错误：{first_error}）")
            })
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn get_codex_quota() -> CodexQuota {
    query_codex_quota_with_retry()
        .await
        .unwrap_or_else(CodexQuota::unavailable)
}

#[tauri::command]
pub async fn check_codex_quota() -> CodexQuota {
    get_codex_quota().await
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

    #[test]
    fn missing_cli_errors_are_not_retried() {
        assert!(!retryable("未找到独立 Codex CLI"));
        assert!(retryable("Codex 额度查询超时"));
    }

    #[test]
    fn command_path_keeps_executable_directory_first() {
        let cli = PathBuf::from(r"C:\Users\tester\AppData\Roaming\npm\codex.cmd");
        let path = augmented_command_path(&cli).unwrap();
        assert_eq!(
            std::env::split_paths(&path).next(),
            cli.parent().map(Path::to_path_buf)
        );
    }
}
