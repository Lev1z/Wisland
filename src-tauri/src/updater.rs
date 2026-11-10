//! Signed updates only; checks never download or execute an installer.
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Status {
    auto_check: bool, phase: String, version: Option<String>, notes: String,
    error: Option<String>, downloaded: u64, total: Option<u64>, checked_at: u64,
}
impl Default for Status {
    fn default() -> Self { Self { auto_check: true, phase: "idle".into(), version: None, notes: String::new(), error: None, downloaded: 0, total: None, checked_at: 0 } }
}
struct Data { status: Status, candidate: Option<Update> }
pub struct State(Mutex<Data>);
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn prefs() -> std::path::PathBuf { dirs::config_dir().unwrap_or_default().join("wisland").join("updates.json") }
fn save(s: &Status) -> Result<(), String> {
    let file = prefs(); std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    // Persist only preference and check time, not candidate URLs or executable data.
    std::fs::write(file, serde_json::to_vec(&serde_json::json!({"autoCheck":s.auto_check,"checkedAt":s.checked_at})).unwrap()).map_err(|e| e.to_string())
}
fn publish(app: &tauri::AppHandle, edit: impl FnOnce(&mut Status)) -> Status {
    let state = app.state::<State>(); let mut data = state.0.lock().unwrap(); edit(&mut data.status);
    let result = data.status.clone(); drop(data); let _ = app.emit("update-status", &result); result
}
fn busy(phase: &str) -> bool { matches!(phase, "checking" | "downloading" | "verifying" | "installing") }
fn allowed(version: &str, current: &str, url: &str) -> bool {
    let (Ok(v), Ok(c)) = (semver::Version::parse(version), semver::Version::parse(current)) else { return false; };
    v > c && v.pre.is_empty() && url == format!("https://github.com/Lev1z/Wisland/releases/download/v{version}/Wisland_{version}_x64-setup.exe")
}
async fn check(app: tauri::AppHandle, automatic: bool) -> Result<Status, String> {
    {
        let state = app.state::<State>(); let mut data = state.0.lock().unwrap();
        if busy(&data.status.phase) || (automatic && (!data.status.auto_check || now().saturating_sub(data.status.checked_at) < 86400)) { return Ok(data.status.clone()); }
        data.candidate = None; data.status.phase = "checking".into(); data.status.error = None; data.status.version = None; data.status.notes.clear();
    }
    publish(&app, |_| {});
    let result = async {
        let update = app.updater_builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?.check().await.map_err(|e| format!("暂时无法检查更新，请稍后重试或前往 GitHub 下载。{e}"))?;
        if let Some(mut update) = update {
            if !allowed(&update.version, &app.package_info().version.to_string(), update.download_url.as_str()) { return Err("更新清单的版本或下载地址不符合安全规则".into()); }
            update.timeout = Some(Duration::from_secs(120));
            let state = app.state::<State>(); let mut data = state.0.lock().unwrap();
            data.status.version = Some(update.version.clone()); data.status.notes = update.body.clone().unwrap_or_default().chars().take(12000).collect();
            data.candidate = Some(update);
        }
        Ok::<(), String>(())
    }.await;
    Ok(publish(&app, |s| { s.checked_at = now(); s.error = result.err(); s.phase = if s.error.is_some() { "error" } else if s.version.is_some() { "available" } else { "current" }.into(); let _ = save(s); }))
}
#[tauri::command]
pub fn get_update_status(app: tauri::AppHandle) -> Status { app.state::<State>().0.lock().unwrap().status.clone() }
#[tauri::command]
pub fn set_auto_update_check(app: tauri::AppHandle, enabled: bool) -> Result<Status, String> {
    { let state = app.state::<State>(); let mut data = state.0.lock().unwrap();
      let mut next = data.status.clone(); next.auto_check = enabled; save(&next)?; data.status = next; }
    Ok(publish(&app, |_| {}))
}
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Status, String> { check(app, false).await }
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, window: tauri::WebviewWindow, confirmed_version: String) -> Result<(), String> {
    if window.label() != "settings" { return Err("请在设置中确认安装更新".into()); }
    let update = {
        let state = app.state::<State>(); let mut data = state.0.lock().unwrap();
        if data.status.phase != "available" { return Err("请先重新检查更新".into()); }
        let update = data.candidate.clone().ok_or("没有待安装更新")?;
        if update.version != confirmed_version { return Err("更新版本已变化，请重新确认".into()); }
        data.status.phase = "downloading".into(); update
    };
    publish(&app, |s| { s.downloaded = 0; s.total = None; });
    let mut received = 0u64; let mut last = std::time::Instant::now();
    let result = update.download(|size, total| { received += size as u64; if last.elapsed() >= Duration::from_millis(200) { publish(&app, |s| { s.downloaded = received; s.total = total; }); last = std::time::Instant::now(); } }, || { publish(&app, |s| s.phase = "verifying".into()); }).await;
    match result {
        Ok(bytes) => {
            publish(&app, |s| s.phase = "installing".into());
            if let Err(e) = update.install(bytes) { publish(&app, |s| { s.phase = "error".into(); s.error = Some(format!("安装失败，请重新检查更新：{e}")); }); return Err(e.to_string()); }
            Ok(())
        }
        Err(e) => { publish(&app, |s| { s.phase = "error".into(); s.error = Some(format!("下载或签名校验失败，未执行安装：{e}")); }); Err(e.to_string()) }
    }
}
pub fn setup(app: &tauri::AppHandle) {
    let saved = std::fs::read(prefs()).ok().and_then(|v| serde_json::from_slice::<Status>(&v).ok()).unwrap_or_default();
    let status = Status { auto_check: saved.auto_check, checked_at: if saved.checked_at <= now() { saved.checked_at } else { 0 }, ..Status::default() };
    app.manage(State(Mutex::new(Data { status, candidate: None })));
    let app = app.clone(); tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop { let _ = check(app.clone(), true).await; tokio::time::sleep(Duration::from_secs(3600)).await; }
    });
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn validates_stable_versions_and_exact_release_host() {
        assert!(allowed("0.2.3", "0.2.2", "https://github.com/Lev1z/Wisland/releases/download/v0.2.3/Wisland_0.2.3_x64-setup.exe"));
        for (v,u) in [("0.2.2","https://github.com/Lev1z/Wisland/releases/download/v0.2.2/Wisland_0.2.2_x64-setup.exe"),("0.2.3-beta.1","https://github.com/a.exe"),("0.2.3","https://github.com.evil/Lev1z/Wisland/releases/download/v0.2.3/Wisland_0.2.3_x64-setup.exe")] { assert!(!allowed(v,"0.2.2",u)); }
    }
    #[test] fn legacy_preferences_default_to_check_only() { let s: Status = serde_json::from_str("{}").unwrap(); assert!(s.auto_check); assert!(!busy(&s.phase)); assert!(s.version.is_none()); assert_eq!(s.checked_at,0); }
}
