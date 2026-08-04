use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

use crate::{agent_status, settings, IslandState};

pub(crate) const CURRENT_ENVIRONMENT_CHECK_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentPlatformStatus {
    webview2_version: String,
    codex_desktop_installed: bool,
    codex_desktop_running: bool,
    codex_hooks_installed: bool,
}

#[cfg(windows)]
fn webview2_version() -> String {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const CLIENT: &str =
        r"Software\Microsoft\EdgeUpdate\Clients\{F1E7E72B-6A5A-48D4-8C78-012C57B10BBF}";
    const CLIENT_WOW64: &str =
        r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F1E7E72B-6A5A-48D4-8C78-012C57B10BBF}";
    [
        (HKEY_CURRENT_USER, CLIENT),
        (HKEY_LOCAL_MACHINE, CLIENT),
        (HKEY_LOCAL_MACHINE, CLIENT_WOW64),
    ]
    .into_iter()
    .find_map(|(root, path)| {
        RegKey::predef(root)
            .open_subkey(path)
            .ok()
            .and_then(|key| key.get_value::<String, _>("pv").ok())
            .filter(|version| !version.trim().is_empty())
    })
    // 能执行到这里说明当前 WebView2 已成功承载 Wisland 页面。
    .unwrap_or_else(|| "正在运行".to_string())
}

#[cfg(not(windows))]
fn webview2_version() -> String {
    "不适用".to_string()
}

#[tauri::command]
pub fn get_environment_platform_status() -> EnvironmentPlatformStatus {
    EnvironmentPlatformStatus {
        webview2_version: webview2_version(),
        codex_desktop_installed: agent_status::codex_desktop_installed(),
        codex_desktop_running: agent_status::codex_desktop_running(),
        codex_hooks_installed: agent_status::codex_status_hooks_installed(),
    }
}

#[tauri::command]
pub fn get_environment_check_active(state: tauri::State<'_, IslandState>) -> bool {
    state.environment_check_active.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn sync_environment_check_height(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, IslandState>,
    height: f64,
    resize: bool,
) {
    if !height.is_finite() {
        return;
    }
    let height = height.clamp(360.0, 640.0);
    state
        .environment_check_expanded_height
        .store(height.to_bits(), Ordering::Relaxed);
    if resize
        && state.environment_check_active.load(Ordering::Relaxed)
        && state.is_expanded.load(Ordering::Relaxed)
    {
        if let Ok(size) = window.inner_size() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let width = size.width as f64 / scale;
            let _ = window.set_size(tauri::LogicalSize::new(
                width,
                height + crate::CAPSULE_TOP_PAD * 2.0,
            ));
        }
    }
}

#[tauri::command]
pub fn start_environment_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, IslandState>,
) -> Result<(), String> {
    state
        .environment_check_active
        .store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.emit("environment-check-start", ());
    }
    Ok(())
}

#[tauri::command]
pub fn complete_environment_check(
    app: tauri::AppHandle,
    state: tauri::State<'_, IslandState>,
) -> Result<(), String> {
    state
        .environment_check_active
        .store(false, Ordering::Relaxed);
    state
        .environment_check_version
        .store(CURRENT_ENVIRONMENT_CHECK_VERSION, Ordering::Relaxed);
    settings::save_settings_to_file(&settings::build_settings_data(&state))?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("environment-check-finished", ());
    }
    Ok(())
}
