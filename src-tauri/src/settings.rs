use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::cc::CcRoute;
use crate::IslandState;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

pub(crate) const LYRIC_OFFSET_MIN_MS: i64 = -3000;
pub(crate) const LYRIC_OFFSET_MAX_MS: i64 = 3000;
pub(crate) const LYRIC_OFFSET_STEP_MS: i64 = 500;

pub(crate) fn clamp_lyric_offset_ms(ms: i64) -> i64 {
    let clamped = ms.clamp(LYRIC_OFFSET_MIN_MS, LYRIC_OFFSET_MAX_MS);
    let rounded = ((clamped as f64) / LYRIC_OFFSET_STEP_MS as f64).round() as i64
        * LYRIC_OFFSET_STEP_MS;
    rounded.clamp(LYRIC_OFFSET_MIN_MS, LYRIC_OFFSET_MAX_MS)
}

pub(crate) fn normalize_app_id(app_id: &str) -> String {
    app_id.trim().to_ascii_lowercase()
}

pub(crate) fn normalize_lyric_offsets(map: &HashMap<String, i64>) -> HashMap<String, i64> {
    map.iter()
        .filter_map(|(key, value)| {
            let key = normalize_app_id(key);
            (!key.is_empty()).then(|| (key, clamp_lyric_offset_ms(*value)))
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SettingsData {
    #[serde(default = "default_lyric_mode")]
    pub lyric_mode: String,
    #[serde(default = "default_lyric_offset_enabled")]
    pub lyric_offset_enabled: bool,
    #[serde(default)]
    pub lyric_offsets_by_player: HashMap<String, i64>,
    #[serde(default = "default_indicator_color")]
    pub indicator_color: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "default_blacklist_processes")]
    pub blacklist_processes: Vec<String>,
    #[serde(default = "default_blacklist_enabled")]
    pub blacklist_enabled: bool,
    #[serde(default = "default_smtc_whitelist_enabled")]
    pub smtc_whitelist_enabled: bool,
    #[serde(default = "default_smtc_app_whitelist")]
    pub smtc_app_whitelist: Vec<String>,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default)]
    pub obsidian_vault_path: String,
    #[serde(default = "default_obsidian_daily_notes_dir")]
    pub obsidian_daily_notes_dir: String,
    #[serde(default = "default_cc_routes")]
    pub cc: Vec<CcRoute>,
}

fn default_lyric_mode() -> String {
    "off".to_string()
}

fn default_lyric_offset_enabled() -> bool {
    true
}

pub(crate) fn default_indicator_color() -> String {
    "#2edb67".to_string()
}

fn default_blacklist_enabled() -> bool {
    true
}

fn default_blacklist_processes() -> Vec<String> {
    [
        "msedge.exe",
        "chrome.exe",
        "brave.exe",
        "vivaldi.exe",
        "opera.exe",
        "firefox.exe",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn default_smtc_whitelist_enabled() -> bool {
    false
}

fn default_smtc_app_whitelist() -> Vec<String> {
    [
        "汽水音乐",
        "cloudmusic.exe",
        "qqmusic.exe",
        "kugou",
        "appleinc.applemusicwin_nzyj5cx40ttqa!app",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_obsidian_daily_notes_dir() -> String {
    "Daily".to_string()
}

fn default_cc_routes() -> Vec<CcRoute> {
    vec![
        CcRoute {
            path: "/Stop".into(),
            tag: "$1 任务完成".into(),
            time: 2000,
        },
        CcRoute {
            path: "/StopFailure".into(),
            tag: "$1 任务出错".into(),
            time: 3000,
        },
        CcRoute {
            path: "/SubagentStop".into(),
            tag: "Subagent 完成工作".into(),
            time: 1000,
        },
        CcRoute {
            path: "/PermissionRequest".into(),
            tag: "$1 有待操作的请求".into(),
            time: 3000,
        },
    ]
}

impl Default for SettingsData {
    fn default() -> Self {
        Self {
            lyric_mode: default_lyric_mode(),
            lyric_offset_enabled: default_lyric_offset_enabled(),
            lyric_offsets_by_player: HashMap::new(),
            indicator_color: default_indicator_color(),
            auto_start: false,
            blacklist_processes: default_blacklist_processes(),
            blacklist_enabled: default_blacklist_enabled(),
            smtc_whitelist_enabled: default_smtc_whitelist_enabled(),
            smtc_app_whitelist: default_smtc_app_whitelist(),
            log_level: default_log_level(),
            obsidian_vault_path: String::new(),
            obsidian_daily_notes_dir: default_obsidian_daily_notes_dir(),
            cc: default_cc_routes(),
        }
    }
}

pub(crate) fn get_settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("wisland");
    let _ = fs::create_dir_all(&path);
    path.push("settings.json");
    path
}

pub(crate) fn load_settings_from_file() -> SettingsData {
    let path = get_settings_path();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(mut data) = serde_json::from_str::<SettingsData>(&content) {
            data.lyric_offsets_by_player = normalize_lyric_offsets(&data.lyric_offsets_by_player);
            return data;
        }
    }

    let defaults = SettingsData::default();
    let _ = save_settings_to_file(&defaults);
    defaults
}

pub(crate) fn save_settings_to_file(data: &SettingsData) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
    fs::write(get_settings_path(), json).map_err(|error| error.to_string())
}

pub(crate) fn build_settings_data(state: &IslandState) -> SettingsData {
    SettingsData {
        lyric_mode: state.lyric_mode.lock().unwrap().clone(),
        lyric_offset_enabled: state.lyric_offset_enabled.load(Ordering::Relaxed),
        lyric_offsets_by_player: state.lyric_offsets_by_player.lock().unwrap().clone(),
        indicator_color: state.indicator_color.lock().unwrap().clone(),
        auto_start: state.auto_start.load(Ordering::Relaxed),
        blacklist_processes: state.blacklist_processes.lock().unwrap().clone(),
        blacklist_enabled: state.blacklist_enabled.load(Ordering::Relaxed),
        smtc_whitelist_enabled: state.smtc_whitelist_enabled.load(Ordering::Relaxed),
        smtc_app_whitelist: state.smtc_app_whitelist.lock().unwrap().clone(),
        log_level: crate::logger::get_level(),
        obsidian_vault_path: state.obsidian_vault_path.lock().unwrap().clone(),
        obsidian_daily_notes_dir: state.obsidian_daily_notes_dir.lock().unwrap().clone(),
        cc: state.cc_routes.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn open_settings(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Wisland 设置")
    .inner_size(960.0, 620.0)
    .min_inner_size(760.0, 500.0)
    .resizable(true)
    .center()
    .build();
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, IslandState>) -> serde_json::Value {
    serde_json::json!({
        "lyric_mode": state.lyric_mode.lock().unwrap().clone(),
        "lyric_offset_enabled": state.lyric_offset_enabled.load(Ordering::Relaxed),
        "indicator_color": state.indicator_color.lock().unwrap().clone(),
        "obsidian_vault_path": state.obsidian_vault_path.lock().unwrap().clone(),
        "obsidian_daily_notes_dir": state.obsidian_daily_notes_dir.lock().unwrap().clone(),
    })
}

#[tauri::command]
pub fn set_obsidian_preferences(
    state: tauri::State<'_, IslandState>,
    vault_path: String,
    daily_notes_dir: String,
) -> Result<(), String> {
    let daily_notes_dir = daily_notes_dir.trim().replace('/', "\\");
    if daily_notes_dir.split('\\').any(|part| part == "..") {
        return Err("每日笔记目录必须位于 Vault 内".into());
    }
    *state.obsidian_vault_path.lock().unwrap() = vault_path.trim().to_string();
    *state.obsidian_daily_notes_dir.lock().unwrap() = if daily_notes_dir.is_empty() {
        default_obsidian_daily_notes_dir()
    } else {
        daily_notes_dir
    };
    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn set_core_preferences(
    app: tauri::AppHandle,
    state: tauri::State<'_, IslandState>,
    indicator_color: String,
    lyric_mode: String,
    lyric_offset_enabled: bool,
) -> Result<(), String> {
    let indicator_color = if indicator_color.starts_with('#') && indicator_color.len() == 7 {
        indicator_color
    } else {
        default_indicator_color()
    };
    let lyric_mode = match lyric_mode.as_str() {
        "off" | "info" | "lyric" => lyric_mode,
        _ => default_lyric_mode(),
    };

    *state.indicator_color.lock().unwrap() = indicator_color.clone();
    *state.lyric_mode.lock().unwrap() = lyric_mode.clone();
    state
        .lyric_offset_enabled
        .store(lyric_offset_enabled, Ordering::Relaxed);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("indicator-color-changed", &indicator_color);
        let _ = window.emit("lyric-mode-changed", &lyric_mode);
    }

    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn get_smtc_whitelist(state: tauri::State<'_, IslandState>) -> Vec<String> {
    state.smtc_app_whitelist.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_smtc_whitelist_enabled(state: tauri::State<'_, IslandState>) -> bool {
    state.smtc_whitelist_enabled.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_smtc_whitelist_enabled(
    state: tauri::State<'_, IslandState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .smtc_whitelist_enabled
        .store(enabled, Ordering::Relaxed);
    crate::media::update_smtc_whitelist(
        enabled,
        state.smtc_app_whitelist.lock().unwrap().clone(),
    );
    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn save_smtc_whitelist(
    state: tauri::State<'_, IslandState>,
    app_ids: Vec<String>,
) -> Result<(), String> {
    let normalized: Vec<String> = app_ids
        .into_iter()
        .map(|value| normalize_app_id(&value))
        .filter(|value| !value.is_empty())
        .collect();
    *state.smtc_app_whitelist.lock().unwrap() = normalized.clone();
    crate::media::update_smtc_whitelist(
        state.smtc_whitelist_enabled.load(Ordering::Relaxed),
        normalized,
    );
    save_settings_to_file(&build_settings_data(&state))
}

const AUTOSTART_REG_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_REG_NAME: &str = "Wisland";

#[tauri::command]
pub fn get_auto_start() -> bool {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        return hkcu
            .open_subkey(AUTOSTART_REG_KEY)
            .and_then(|key| key.get_value::<String, _>(AUTOSTART_REG_NAME))
            .is_ok();
    }
    #[cfg(not(windows))]
    false
}

fn apply_auto_start(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run_key, _) = hkcu
            .create_subkey(AUTOSTART_REG_KEY)
            .map_err(|error| format!("打开注册表失败: {error}"))?;
        if enabled {
            let executable = std::env::current_exe()
                .map_err(|error| format!("获取程序路径失败: {error}"))?
                .to_string_lossy()
                .to_string();
            run_key
                .set_value(AUTOSTART_REG_NAME, &executable)
                .map_err(|error| format!("写入注册表失败: {error}"))?;
        } else {
            let _ = run_key.delete_value(AUTOSTART_REG_NAME);
        }
    }
    #[cfg(not(windows))]
    let _ = enabled;
    Ok(())
}

#[tauri::command]
pub fn set_auto_start(
    state: tauri::State<'_, IslandState>,
    enabled: bool,
) -> Result<(), String> {
    apply_auto_start(enabled)?;
    state.auto_start.store(enabled, Ordering::Relaxed);
    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn get_blacklist(state: tauri::State<'_, IslandState>) -> Vec<String> {
    state.blacklist_processes.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_blacklist_enabled(state: tauri::State<'_, IslandState>) -> bool {
    state.blacklist_enabled.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn set_blacklist_enabled(
    state: tauri::State<'_, IslandState>,
    enabled: bool,
) -> Result<(), String> {
    state.blacklist_enabled.store(enabled, Ordering::Relaxed);
    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn save_blacklist(
    state: tauri::State<'_, IslandState>,
    processes: Vec<String>,
) -> Result<(), String> {
    let normalized: Vec<String> = processes
        .into_iter()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect();
    *state.blacklist_processes.lock().unwrap() = normalized;
    save_settings_to_file(&build_settings_data(&state))
}
