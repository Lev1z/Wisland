use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, UNIX_EPOCH};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::IslandState;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const QUERY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuota {
    pub(crate) available: bool,
    remaining_percent: Option<f64>,
    used_percent: Option<f64>,
    window_duration_mins: Option<u64>,
    resets_at: Option<u64>,
    message: Option<String>,
    source: Option<String>,
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
            source: None,
        }
    }
}

#[derive(Debug, Clone)]
struct ResolvedCli {
    path: PathBuf,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    ready: bool,
    desktop_installed: bool,
    connectable: bool,
    source: Option<String>,
    message: String,
}

fn explicit_cli() -> Option<ResolvedCli> {
    std::env::var_os("WISLAND_CODEX_CLI")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .map(|path| ResolvedCli {
            path,
            source: "WISLAND_CODEX_CLI".into(),
        })
}

fn npm_cli() -> Option<ResolvedCli> {
    dirs::config_dir()
        .map(|directory| directory.join("npm").join("codex.cmd"))
        .filter(|path| path.is_file())
        .map(|path| ResolvedCli {
            path,
            source: "独立 Codex CLI".into(),
        })
}

fn path_cli() -> Option<ResolvedCli> {
    let path = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let names = ["codex.exe", "codex.cmd", "codex.bat"];
    #[cfg(not(windows))]
    let names = ["codex"];

    std::env::split_paths(&path).find_map(|directory| {
        names.iter().find_map(|name| {
            let candidate = directory.join(name);
            candidate.is_file().then(|| ResolvedCli {
                path: candidate,
                source: "PATH 中的 Codex CLI".into(),
            })
        })
    })
}

fn is_codex_desktop_package_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with("openai.codex_")
}

fn desktop_cli_override() -> Option<(String, PathBuf)> {
    std::env::var_os("WISLAND_CODEX_DESKTOP_CLI")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .map(|path| ("override".into(), path))
}

#[cfg(windows)]
fn desktop_cli_source() -> Option<(String, PathBuf)> {
    if let Some(value) = desktop_cli_override() {
        return Some(value);
    }

    let windows_apps = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)?
        .join("WindowsApps");
    let mut candidates = fs::read_dir(windows_apps)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_codex_desktop_package_name(&name) {
                return None;
            }
            let cli = entry.path().join("app").join("resources").join("codex.exe");
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            cli.is_file().then_some((modified, name, cli))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    candidates
        .into_iter()
        .next()
        .map(|(_, name, path)| (name, path))
}

#[cfg(not(windows))]
fn desktop_cli_source() -> Option<(String, PathBuf)> {
    desktop_cli_override()
}

fn desktop_cache_path(package_name: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|directory| {
        directory
            .join("wisland")
            .join("runtime")
            .join("codex-desktop")
            .join(package_name)
            .join("codex.exe")
    })
}

fn cached_desktop_cli(package_name: &str) -> Option<ResolvedCli> {
    desktop_cache_path(package_name)
        .filter(|path| path.is_file())
        .map(|path| ResolvedCli {
            path,
            source: "Codex Desktop 内置 CLI".into(),
        })
}

fn copy_desktop_cli(package_name: &str, source: &Path) -> Result<ResolvedCli, String> {
    let target = desktop_cache_path(package_name)
        .ok_or_else(|| "无法定位 Wisland 本地数据目录".to_string())?;
    if target.is_file() {
        return Ok(ResolvedCli {
            path: target,
            source: "Codex Desktop 内置 CLI".into(),
        });
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Codex CLI 缓存路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建额度服务目录：{error}"))?;
    let temporary = target.with_extension(format!("{}.tmp", std::process::id()));
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    fs::copy(source, &temporary)
        .map_err(|error| format!("无法复用 Codex Desktop 内置 CLI：{error}"))?;
    match fs::rename(&temporary, &target) {
        Ok(()) => {}
        Err(_) if target.is_file() => {
            let _ = fs::remove_file(&temporary);
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法启用 Codex Desktop 内置 CLI：{error}"));
        }
    }
    Ok(ResolvedCli {
        path: target,
        source: "Codex Desktop 内置 CLI".into(),
    })
}

fn existing_cli(desktop: Option<&(String, PathBuf)>) -> Option<ResolvedCli> {
    explicit_cli()
        .or_else(|| desktop.and_then(|(package, _)| cached_desktop_cli(package)))
        .or_else(npm_cli)
        .or_else(path_cli)
}

fn resolve_cli(allow_desktop_copy: bool) -> Result<ResolvedCli, String> {
    let desktop = desktop_cli_source();
    if let Some(cli) = existing_cli(desktop.as_ref()) {
        return Ok(cli);
    }
    if allow_desktop_copy {
        if let Some((package, source)) = desktop {
            return copy_desktop_cli(&package, &source);
        }
    }
    Err("未找到 Codex CLI；请安装并登录 Codex Desktop 后重试".into())
}

pub(crate) fn codex_cli_status() -> CodexCliStatus {
    let desktop = desktop_cli_source();
    let existing = existing_cli(desktop.as_ref());
    let desktop_installed = desktop.is_some();
    match existing {
        Some(cli) => CodexCliStatus {
            ready: true,
            desktop_installed,
            connectable: true,
            source: Some(cli.source),
            message: "额度服务已就绪".into(),
        },
        None if desktop_installed => CodexCliStatus {
            ready: false,
            desktop_installed: true,
            connectable: true,
            source: Some("Codex Desktop 内置 CLI".into()),
            message: "可从 Codex Desktop 连接，无需安装 npm".into(),
        },
        None => CodexCliStatus {
            ready: false,
            desktop_installed: false,
            connectable: false,
            source: None,
            message: "未找到 Codex Desktop 或独立 Codex CLI".into(),
        },
    }
}

#[tauri::command]
pub fn get_codex_cli_status() -> CodexCliStatus {
    codex_cli_status()
}

fn codex_command() -> Result<(Command, String), String> {
    let cli = resolve_cli(true)?;
    let mut command = {
        let is_script = cli
            .path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat")
            });
        if is_script {
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c"]).arg(&cli.path);
            command
        } else {
            Command::new(&cli.path)
        }
    };

    command.args(["app-server", "--listen", "stdio://"]);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    Ok((command, cli.source))
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
        source: None,
    })
}

async fn read_response_for_id<R>(reader: &mut R, request_id: u64) -> Result<Value, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|error| format!("读取 Codex App Server 失败：{error}"))?;
        if bytes == 0 {
            return Err("Codex App Server 在返回结果前退出".to_string());
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(request_id) {
            return Ok(value);
        }
    }
}

async fn query_codex_quota() -> Result<CodexQuota, String> {
    let (mut command, source) = codex_command()?;
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("无法启动 {source}：{error}"))?;
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
        let initialize = serde_json::json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "wisland",
                    "title": "Wisland",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .map_err(|error| format!("写入 Codex 初始化请求失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex 初始化请求失败：{error}"))?;

        // 新版 Codex Desktop App Server 会并发处理输入；必须等 initialize
        // 返回后再发额度请求，否则会收到 `Not initialized`。
        let initialize_response = read_response_for_id(&mut reader, 1).await?;
        if let Some(error) = initialize_response.get("error") {
            return Err(format!("Codex App Server 初始化失败：{error}"));
        }

        let requests = concat!(
            "{\"method\":\"initialized\",\"params\":{}}\n",
            "{\"method\":\"account/rateLimits/read\",\"id\":2}\n"
        );
        stdin
            .write_all(requests.as_bytes())
            .await
            .map_err(|error| format!("写入 Codex 额度请求失败：{error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("刷新 Codex 额度请求失败：{error}"))?;
        quota_from_response(&read_response_for_id(&mut reader, 2).await?)
    };

    let result = timeout(QUERY_TIMEOUT, exchange)
        .await
        .map_err(|_| "Codex 额度查询超时".to_string())?;
    let _ = child.kill().await;
    result.map(|mut quota| {
        quota.source = Some(source);
        quota
    })
}

#[tauri::command]
pub async fn get_codex_quota(state: tauri::State<'_, IslandState>) -> Result<CodexQuota, String> {
    let onboarding_completed = state
        .onboarding_completed
        .load(std::sync::atomic::Ordering::Relaxed);
    drop(state);
    if !onboarding_completed {
        return Ok(CodexQuota::unavailable("请先完成 Wisland 启动检查"));
    }
    Ok(query_codex_quota()
        .await
        .unwrap_or_else(CodexQuota::unavailable))
}

#[tauri::command]
pub async fn connect_codex_quota() -> CodexQuota {
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

    #[test]
    fn identifies_codex_desktop_packages_only() {
        assert!(is_codex_desktop_package_name(
            "OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0"
        ));
        assert!(!is_codex_desktop_package_name(
            "OpenAI.ChatGPT_1.2026.196.0_x64__2p2nqsd0c76g0"
        ));
    }

    #[tokio::test]
    async fn reads_the_requested_response_after_notifications() {
        let input = concat!(
            "{\"method\":\"notice\",\"params\":{}}\n",
            "not-json\n",
            "{\"id\":2,\"result\":{\"ok\":true}}\n"
        );
        let mut reader = tokio::io::BufReader::new(input.as_bytes());
        let value = read_response_for_id(&mut reader, 2).await.unwrap();
        assert_eq!(value["result"]["ok"], true);
    }
}
