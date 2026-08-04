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
    let rounded =
        ((clamped as f64) / LYRIC_OFFSET_STEP_MS as f64).round() as i64 * LYRIC_OFFSET_STEP_MS;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomAsset {
    pub id: String,
    pub name: String,
    pub data_url: String,
}

fn normalize_custom_assets(values: &[CustomAsset]) -> Vec<CustomAsset> {
    let mut normalized = Vec::new();
    for value in values.iter().take(24) {
        let id = value.id.trim();
        let data_url = value.data_url.trim();
        if id.is_empty()
            || !data_url.starts_with("data:image/")
            || data_url.len() > 6 * 1024 * 1024
            || normalized.iter().any(|item: &CustomAsset| item.id == id)
        {
            continue;
        }
        normalized.push(CustomAsset {
            id: id.chars().take(80).collect(),
            name: value.name.trim().chars().take(100).collect(),
            data_url: data_url.to_string(),
        });
    }
    normalized
}

fn migrate_embedded_asset(
    source: &mut String,
    assets: &mut Vec<CustomAsset>,
    id: &str,
    name: &str,
) {
    if source.starts_with("data:image/") {
        assets.push(CustomAsset {
            id: id.to_string(),
            name: name.to_string(),
            data_url: source.clone(),
        });
        *source = format!("asset:{id}");
    } else if source.starts_with("preset:") {
        source.clear();
    }
}

fn source_exists(source: &str, assets: &[CustomAsset]) -> bool {
    if matches!(source, "builtin:cat-wave" | "builtin:dog-wave") {
        return true;
    }
    source
        .strip_prefix("asset:")
        .is_some_and(|id| assets.iter().any(|asset| asset.id == id))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SettingsData {
    #[serde(default)]
    pub environment_check_version: u32,
    #[serde(default = "default_lyric_mode")]
    pub lyric_mode: String,
    #[serde(default = "default_lyric_offset_enabled")]
    pub lyric_offset_enabled: bool,
    #[serde(default)]
    pub lyric_offsets_by_player: HashMap<String, i64>,
    #[serde(default = "default_indicator_color")]
    pub indicator_color: String,
    #[serde(default = "default_capsule_opacity")]
    pub capsule_opacity: f64,
    #[serde(default = "default_capsule_scale")]
    pub capsule_scale: f64,
    #[serde(default = "default_icon_bar_style")]
    pub icon_bar_style: String,
    #[serde(default = "default_icon_bar_order")]
    pub icon_bar_order: Vec<String>,
    #[serde(default = "default_border_effect")]
    pub border_effect: String,
    #[serde(default)]
    pub border_custom_source: String,
    #[serde(default = "default_left_visual_mode")]
    pub left_visual_mode: String,
    #[serde(default)]
    pub left_visual_source: String,
    #[serde(default = "default_right_visual_mode")]
    pub right_visual_mode: String,
    #[serde(default)]
    pub right_visual_source: String,
    #[serde(default)]
    pub visual_assets: Vec<CustomAsset>,
    #[serde(default)]
    pub border_assets: Vec<CustomAsset>,
    #[serde(default)]
    pub rainbow_border: bool,
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
    "lyric".to_string()
}

fn default_lyric_offset_enabled() -> bool {
    true
}

pub(crate) fn default_indicator_color() -> String {
    "#ffffff".to_string()
}

fn default_capsule_opacity() -> f64 {
    1.0
}

fn default_capsule_scale() -> f64 {
    1.0
}

fn normalize_capsule_scale(value: f64) -> f64 {
    [0.8, 1.0, 1.25, 1.5]
        .into_iter()
        .min_by(|left, right| {
            (left - value)
                .abs()
                .partial_cmp(&(right - value).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(1.0)
}

fn default_icon_bar_style() -> String {
    "option-wheel".to_string()
}

fn normalize_icon_bar_style(value: &str) -> String {
    match value.trim() {
        "classic" => "classic".to_string(),
        "option-wheel" => "option-wheel".to_string(),
        // The old Default value is migrated to the new default.
        "default" => "option-wheel".to_string(),
        _ => default_icon_bar_style(),
    }
}

fn default_icon_bar_order() -> Vec<String> {
    ["time", "lyric", "journal", "tray"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn normalize_icon_bar_order(values: &[String]) -> Vec<String> {
    let defaults = default_icon_bar_order();
    let mut normalized = Vec::with_capacity(defaults.len());
    for value in values.iter().chain(defaults.iter()) {
        if defaults.contains(value) && !normalized.contains(value) {
            normalized.push(value.clone());
        }
    }
    normalized
}

fn default_border_effect() -> String {
    "off".to_string()
}

fn normalize_border_effect(value: &str) -> String {
    match value.trim() {
        "aurora" | "mono" | "custom" => value.trim().to_string(),
        _ => default_border_effect(),
    }
}

fn default_left_visual_mode() -> String {
    "codex".to_string()
}

fn normalize_left_visual_mode(value: &str) -> String {
    match value.trim() {
        "custom" => "custom".to_string(),
        _ => default_left_visual_mode(),
    }
}

fn default_right_visual_mode() -> String {
    "status".to_string()
}

fn normalize_right_visual_mode(value: &str) -> String {
    match value.trim() {
        "custom" => "custom".to_string(),
        _ => default_right_visual_mode(),
    }
}

fn default_blacklist_enabled() -> bool {
    false
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
            environment_check_version: 0,
            lyric_mode: default_lyric_mode(),
            lyric_offset_enabled: default_lyric_offset_enabled(),
            lyric_offsets_by_player: HashMap::new(),
            indicator_color: default_indicator_color(),
            capsule_opacity: default_capsule_opacity(),
            capsule_scale: default_capsule_scale(),
            icon_bar_style: default_icon_bar_style(),
            icon_bar_order: default_icon_bar_order(),
            border_effect: default_border_effect(),
            border_custom_source: String::new(),
            left_visual_mode: default_left_visual_mode(),
            left_visual_source: String::new(),
            right_visual_mode: default_right_visual_mode(),
            right_visual_source: String::new(),
            visual_assets: Vec::new(),
            border_assets: Vec::new(),
            rainbow_border: false,
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
            data.capsule_opacity = data.capsule_opacity.clamp(0.6, 1.0);
            data.capsule_scale = normalize_capsule_scale(data.capsule_scale);
            data.icon_bar_style = normalize_icon_bar_style(&data.icon_bar_style);
            data.icon_bar_order = normalize_icon_bar_order(&data.icon_bar_order);
            data.border_effect = if data.border_effect == "off" && data.rainbow_border {
                "aurora".to_string()
            } else {
                normalize_border_effect(&data.border_effect)
            };
            data.left_visual_mode = normalize_left_visual_mode(&data.left_visual_mode);
            data.right_visual_mode = normalize_right_visual_mode(&data.right_visual_mode);
            data.visual_assets = normalize_custom_assets(&data.visual_assets);
            data.border_assets = normalize_custom_assets(&data.border_assets);
            migrate_embedded_asset(
                &mut data.left_visual_source,
                &mut data.visual_assets,
                "legacy-left",
                "旧左侧素材",
            );
            migrate_embedded_asset(
                &mut data.right_visual_source,
                &mut data.visual_assets,
                "legacy-right",
                "旧右侧素材",
            );
            migrate_embedded_asset(
                &mut data.border_custom_source,
                &mut data.border_assets,
                "legacy-border",
                "旧边框素材",
            );
            data.visual_assets = normalize_custom_assets(&data.visual_assets);
            data.border_assets = normalize_custom_assets(&data.border_assets);
            if data.left_visual_mode == "custom"
                && !source_exists(&data.left_visual_source, &data.visual_assets)
            {
                data.left_visual_mode = default_left_visual_mode();
                data.left_visual_source.clear();
            }
            if data.right_visual_mode == "custom"
                && !source_exists(&data.right_visual_source, &data.visual_assets)
            {
                data.right_visual_mode = default_right_visual_mode();
                data.right_visual_source.clear();
            }
            if data.border_effect == "custom"
                && !source_exists(&data.border_custom_source, &data.border_assets)
            {
                data.border_effect = default_border_effect();
                data.border_custom_source.clear();
            }
            // Music information and lyrics are now always available.
            data.lyric_mode = default_lyric_mode();
            data.lyric_offset_enabled = true;
            if data.indicator_color.eq_ignore_ascii_case("#2edb67") {
                data.indicator_color = default_indicator_color();
            }
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
        environment_check_version: state.environment_check_version.load(Ordering::Relaxed),
        lyric_mode: state.lyric_mode.lock().unwrap().clone(),
        lyric_offset_enabled: state.lyric_offset_enabled.load(Ordering::Relaxed),
        lyric_offsets_by_player: state.lyric_offsets_by_player.lock().unwrap().clone(),
        indicator_color: state.indicator_color.lock().unwrap().clone(),
        capsule_opacity: *state.capsule_opacity.lock().unwrap(),
        capsule_scale: *state.capsule_scale.lock().unwrap(),
        icon_bar_style: state.icon_bar_style.lock().unwrap().clone(),
        icon_bar_order: state.icon_bar_order.lock().unwrap().clone(),
        border_effect: state.border_effect.lock().unwrap().clone(),
        border_custom_source: state.border_custom_source.lock().unwrap().clone(),
        left_visual_mode: state.left_visual_mode.lock().unwrap().clone(),
        left_visual_source: state.left_visual_source.lock().unwrap().clone(),
        right_visual_mode: state.right_visual_mode.lock().unwrap().clone(),
        right_visual_source: state.right_visual_source.lock().unwrap().clone(),
        visual_assets: state.visual_assets.lock().unwrap().clone(),
        border_assets: state.border_assets.lock().unwrap().clone(),
        rainbow_border: state.rainbow_border.load(Ordering::Relaxed),
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

fn settings_page(page: Option<String>) -> Option<String> {
    page.filter(|page| {
        matches!(
            page.as_str(),
            "general" | "music" | "codex" | "obsidian" | "custom" | "behavior" | "about"
        )
    })
}

fn open_settings_window(app: tauri::AppHandle, page: Option<String>) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("settings-menu-open", ());
        if let Some(page) = page {
            let _ = window.emit("settings-page-open", page);
        }
        return;
    }

    let url = page
        .map(|page| format!("settings.html?page={page}"))
        .unwrap_or_else(|| "settings.html".to_string());
    let builder =
        tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App(url.into()))
            .title("Wisland 设置")
            .inner_size(960.0, 620.0)
            .min_inner_size(760.0, 500.0)
            .background_color(tauri::window::Color(13, 13, 13, 255))
            .decorations(false)
            .resizable(true)
            .center();

    let result = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .and_then(|icon| builder.icon(icon))
        .and_then(|builder| builder.build());
    if let Err(error) = result {
        crate::logger::error("Settings", &format!("无法打开设置窗口：{error}"));
    }
}

fn schedule_settings_window(app: tauri::AppHandle, page: Option<String>) {
    std::thread::spawn(move || {
        // 创建第二个 WebView2 必须等当前 IPC / 菜单回调完全返回，
        // 否则 Windows 上可能只出现一个无响应的黑色窗口。
        std::thread::sleep(std::time::Duration::from_millis(60));
        open_settings_window(app, page);
    });
}

#[tauri::command]
pub fn open_settings(app: tauri::AppHandle) {
    schedule_settings_window(app, None);
}

#[tauri::command]
pub fn open_settings_page(app: tauri::AppHandle, page: String) {
    schedule_settings_window(app, settings_page(Some(page)));
}

#[tauri::command]
pub fn open_github_profile() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("https://github.com/Lev1z")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 GitHub 主页：{error}"))
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, IslandState>) -> serde_json::Value {
    serde_json::json!({
        "lyric_mode": state.lyric_mode.lock().unwrap().clone(),
        "environment_check_version": state.environment_check_version.load(Ordering::Relaxed),
        "environment_check_completed": state.environment_check_version.load(Ordering::Relaxed)
            >= crate::environment_check::CURRENT_ENVIRONMENT_CHECK_VERSION,
        "lyric_offset_enabled": state.lyric_offset_enabled.load(Ordering::Relaxed),
        "indicator_color": state.indicator_color.lock().unwrap().clone(),
        "capsule_opacity": *state.capsule_opacity.lock().unwrap(),
        "capsule_scale": *state.capsule_scale.lock().unwrap(),
        "icon_bar_style": state.icon_bar_style.lock().unwrap().clone(),
        "icon_bar_order": state.icon_bar_order.lock().unwrap().clone(),
        "border_effect": state.border_effect.lock().unwrap().clone(),
        "border_custom_source": state.border_custom_source.lock().unwrap().clone(),
        "left_visual_mode": state.left_visual_mode.lock().unwrap().clone(),
        "left_visual_source": state.left_visual_source.lock().unwrap().clone(),
        "right_visual_mode": state.right_visual_mode.lock().unwrap().clone(),
        "right_visual_source": state.right_visual_source.lock().unwrap().clone(),
        "visual_assets": state.visual_assets.lock().unwrap().clone(),
        "border_assets": state.border_assets.lock().unwrap().clone(),
        "rainbow_border": state.rainbow_border.load(Ordering::Relaxed),
        "obsidian_vault_path": state.obsidian_vault_path.lock().unwrap().clone(),
        "obsidian_daily_notes_dir": state.obsidian_daily_notes_dir.lock().unwrap().clone(),
    })
}

#[tauri::command]
pub fn set_appearance_preferences(
    app: tauri::AppHandle,
    state: tauri::State<'_, IslandState>,
    opacity: f64,
    scale: f64,
    icon_bar_style: String,
    icon_bar_order: Vec<String>,
    border_effect: String,
    border_custom_source: String,
    left_visual_mode: String,
    left_visual_source: String,
    right_visual_mode: String,
    right_visual_source: String,
    visual_assets: Vec<CustomAsset>,
    border_assets: Vec<CustomAsset>,
) -> Result<(), String> {
    let opacity = opacity.clamp(0.6, 1.0);
    let scale = normalize_capsule_scale(scale);
    let icon_bar_style = normalize_icon_bar_style(&icon_bar_style);
    let icon_bar_order = normalize_icon_bar_order(&icon_bar_order);
    let mut border_effect = normalize_border_effect(&border_effect);
    let mut left_visual_mode = normalize_left_visual_mode(&left_visual_mode);
    let mut right_visual_mode = normalize_right_visual_mode(&right_visual_mode);
    let visual_assets = normalize_custom_assets(&visual_assets);
    let border_assets = normalize_custom_assets(&border_assets);
    let left_visual_source = if source_exists(&left_visual_source, &visual_assets) {
        left_visual_source
    } else {
        left_visual_mode = default_left_visual_mode();
        String::new()
    };
    let right_visual_source = if source_exists(&right_visual_source, &visual_assets) {
        right_visual_source
    } else {
        right_visual_mode = default_right_visual_mode();
        String::new()
    };
    let border_custom_source = if source_exists(&border_custom_source, &border_assets) {
        border_custom_source
    } else {
        if border_effect == "custom" {
            border_effect = default_border_effect();
        }
        String::new()
    };
    *state.capsule_opacity.lock().unwrap() = opacity;
    *state.capsule_scale.lock().unwrap() = scale;
    *state.icon_bar_style.lock().unwrap() = icon_bar_style.clone();
    *state.icon_bar_order.lock().unwrap() = icon_bar_order.clone();
    *state.border_effect.lock().unwrap() = border_effect.clone();
    *state.border_custom_source.lock().unwrap() = border_custom_source.clone();
    *state.left_visual_mode.lock().unwrap() = left_visual_mode.clone();
    *state.left_visual_source.lock().unwrap() = left_visual_source.clone();
    *state.right_visual_mode.lock().unwrap() = right_visual_mode.clone();
    *state.right_visual_source.lock().unwrap() = right_visual_source.clone();
    *state.visual_assets.lock().unwrap() = visual_assets.clone();
    *state.border_assets.lock().unwrap() = border_assets.clone();
    state
        .rainbow_border
        .store(border_effect != "off", Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(
            "appearance-changed",
            serde_json::json!({
                "opacity": opacity,
                "scale": scale,
                "iconBarStyle": icon_bar_style,
                "iconBarOrder": icon_bar_order,
                "borderEffect": border_effect,
                "borderCustomSource": border_custom_source,
                "leftVisualMode": left_visual_mode,
                "leftVisualSource": left_visual_source,
                "rightVisualMode": right_visual_mode,
                "rightVisualSource": right_visual_source,
                "visualAssets": visual_assets,
                "borderAssets": border_assets,
            }),
        );
    }
    save_settings_to_file(&build_settings_data(&state))
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
    let _ = (lyric_mode, lyric_offset_enabled);
    let indicator_color = if indicator_color.starts_with('#') && indicator_color.len() == 7 {
        indicator_color
    } else {
        default_indicator_color()
    };
    let lyric_mode = default_lyric_mode();

    *state.indicator_color.lock().unwrap() = indicator_color.clone();
    *state.lyric_mode.lock().unwrap() = lyric_mode.clone();
    state.lyric_offset_enabled.store(true, Ordering::Relaxed);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("indicator-color-changed", &indicator_color);
        let _ = window.emit("lyric-mode-changed", &lyric_mode);
    }

    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn get_lyric_offset_players(state: tauri::State<'_, IslandState>) -> serde_json::Value {
    let mut players: Vec<_> = state
        .lyric_offsets_by_player
        .lock()
        .unwrap()
        .iter()
        .map(|(app_id, ms)| serde_json::json!({ "app_id": app_id, "ms": ms }))
        .collect();
    players.sort_by(|left, right| {
        left["app_id"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["app_id"].as_str().unwrap_or_default())
    });
    serde_json::json!({
        "enabled": state.lyric_offset_enabled.load(Ordering::Relaxed),
        "active_app_id": state.active_player_app_id.lock().unwrap().clone(),
        "min_ms": LYRIC_OFFSET_MIN_MS,
        "max_ms": LYRIC_OFFSET_MAX_MS,
        "step_ms": LYRIC_OFFSET_STEP_MS,
        "players": players,
    })
}

#[tauri::command]
pub fn set_lyric_offset_enabled(
    state: tauri::State<'_, IslandState>,
    enabled: bool,
) -> Result<(), String> {
    state.lyric_offset_enabled.store(enabled, Ordering::Relaxed);
    save_settings_to_file(&build_settings_data(&state))
}

#[tauri::command]
pub fn set_lyric_offset_for_player(
    state: tauri::State<'_, IslandState>,
    app_id: String,
    ms: i64,
) -> Result<i64, String> {
    let app_id = normalize_app_id(&app_id);
    if app_id.is_empty() {
        return Err("播放器标识不能为空".into());
    }
    let ms = clamp_lyric_offset_ms(ms);
    state
        .lyric_offsets_by_player
        .lock()
        .unwrap()
        .insert(app_id, ms);
    save_settings_to_file(&build_settings_data(&state))?;
    Ok(ms)
}

#[tauri::command]
pub fn delete_lyric_offset_player(
    state: tauri::State<'_, IslandState>,
    app_id: String,
) -> Result<(), String> {
    state
        .lyric_offsets_by_player
        .lock()
        .unwrap()
        .remove(&normalize_app_id(&app_id));
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
    crate::media::update_smtc_whitelist(enabled, state.smtc_app_whitelist.lock().unwrap().clone());
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
pub fn set_auto_start(state: tauri::State<'_, IslandState>, enabled: bool) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::{
        normalize_border_effect, normalize_custom_assets, normalize_icon_bar_order,
        normalize_icon_bar_style, settings_page, source_exists, CustomAsset, SettingsData,
    };

    #[test]
    fn icon_bar_style_defaults_and_rejects_unknown_values() {
        assert_eq!(SettingsData::default().icon_bar_style, "option-wheel");
        assert_eq!(normalize_icon_bar_style("classic"), "classic");
        assert_eq!(normalize_icon_bar_style("option-wheel"), "option-wheel");
        assert_eq!(normalize_icon_bar_style("default"), "option-wheel");
        assert_eq!(normalize_icon_bar_style("unexpected"), "option-wheel");
    }

    #[test]
    fn icon_order_is_unique_and_complete() {
        let input = vec!["tray".into(), "time".into(), "tray".into()];
        assert_eq!(
            normalize_icon_bar_order(&input),
            vec!["tray", "time", "lyric", "journal"]
        );
    }

    #[test]
    fn custom_assets_are_deduplicated_and_invalid_data_is_dropped() {
        let input = vec![
            CustomAsset {
                id: "one".into(),
                name: "first".into(),
                data_url: "data:image/gif;base64,AA".into(),
            },
            CustomAsset {
                id: "one".into(),
                name: "duplicate".into(),
                data_url: "data:image/png;base64,BB".into(),
            },
            CustomAsset {
                id: "bad".into(),
                name: "bad".into(),
                data_url: "https://example.com/a.gif".into(),
            },
        ];
        let normalized = normalize_custom_assets(&input);
        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].name, "first");
        assert_eq!(normalize_border_effect("klein"), "off");
        assert!(source_exists("builtin:cat-wave", &[]));
        assert!(source_exists("builtin:dog-wave", &[]));
    }

    #[test]
    fn environment_check_and_blacklist_have_safe_defaults() {
        let legacy: SettingsData = serde_json::from_str(r#"{"capsule_scale":1.0}"#).unwrap();
        assert_eq!(legacy.environment_check_version, 0);
        assert_eq!(SettingsData::default().environment_check_version, 0);
        assert!(!SettingsData::default().blacklist_enabled);
    }

    #[test]
    fn settings_window_accepts_only_known_pages() {
        assert_eq!(
            settings_page(Some("obsidian".into())).as_deref(),
            Some("obsidian")
        );
        assert_eq!(settings_page(Some("unknown".into())), None);
    }
}
