use serde::Serialize;
use std::path::Path;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

use crate::{agent_status, codex_usage, media, settings, IslandState};

#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
#[cfg(windows)]
use winreg::RegKey;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingStatus {
    runtime_ok: bool,
    webview2_version: Option<String>,
    codex_desktop_running: bool,
    codex_cli: codex_usage::CodexCliStatus,
    hooks_installed: bool,
    smtc_sessions: Vec<media::SmtcSessionDiagnostic>,
    smtc_error: Option<String>,
    obsidian_configured: bool,
}

#[cfg(windows)]
fn webview2_version() -> Option<String> {
    const CLIENT: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const CLIENT_WOW64: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        (HKEY_CURRENT_USER, CLIENT),
        (HKEY_LOCAL_MACHINE, CLIENT),
        (HKEY_LOCAL_MACHINE, CLIENT_WOW64),
    ]
    .into_iter()
    .find_map(|(hive, path)| {
        RegKey::predef(hive)
            .open_subkey(path)
            .ok()
            .and_then(|key| key.get_value::<String, _>("pv").ok())
            .filter(|version| !version.trim().is_empty())
    })
}

#[cfg(not(windows))]
fn webview2_version() -> Option<String> {
    None
}

fn obsidian_configured(state: &IslandState) -> bool {
    let value = state.obsidian_vault_path.lock().unwrap().clone();
    !value.trim().is_empty() && Path::new(&value).join(".obsidian").is_dir()
}

#[tauri::command]
pub fn get_onboarding_status(state: tauri::State<'_, IslandState>) -> OnboardingStatus {
    let sessions = media::diagnose_smtc_sessions();
    let (smtc_sessions, smtc_error) = match sessions {
        Ok(values) => (values, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    OnboardingStatus {
        runtime_ok: true,
        webview2_version: webview2_version(),
        codex_desktop_running: agent_status::codex_desktop_running(),
        codex_cli: codex_usage::codex_cli_status(),
        hooks_installed: agent_status::codex_hooks_installed(),
        smtc_sessions,
        smtc_error,
        obsidian_configured: obsidian_configured(&state),
    }
}

pub(crate) fn open_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("onboarding") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "onboarding",
        tauri::WebviewUrl::App("onboarding.html".into()),
    )
    .title("Wisland 启动检查")
    .inner_size(720.0, 650.0)
    .min_inner_size(680.0, 600.0)
    .background_color(tauri::window::Color(10, 10, 10, 255))
    .decorations(false)
    .closable(false)
    .resizable(false)
    .center();

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .map_err(|error| format!("无法读取应用图标：{error}"))?;
    builder
        .icon(icon)
        .map_err(|error| format!("无法设置启动检查图标：{error}"))?
        .build()
        .map(|_| ())
        .map_err(|error| format!("无法打开启动检查：{error}"))
}

#[tauri::command]
pub fn open_onboarding_window(app: tauri::AppHandle) -> Result<(), String> {
    open_onboarding(app)
}

#[tauri::command]
pub fn complete_onboarding(
    app: tauri::AppHandle,
    state: tauri::State<'_, IslandState>,
) -> Result<(), String> {
    state.onboarding_completed.store(true, Ordering::Relaxed);
    settings::save_settings_to_file(&settings::build_settings_data(&state))?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.emit("onboarding-complete", ());
    }
    if let Some(window) = app.get_webview_window("onboarding") {
        let _ = window.close();
    }
    Ok(())
}
