use crate::{agent_status, codex_usage, settings, tray_effects, IslandState};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    #[default]
    Capsule,
    Tray,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySnapshot {
    quota: codex_usage::CodexQuota,
    phase: String,
    stale: bool,
    updated_at: Option<u64>,
}

pub struct TrayState {
    snapshot: Mutex<TraySnapshot>,
    expanded: AtomicBool,
    refreshing: AtomicBool,
    last_success: Mutex<Option<Instant>>,
    appearance: Mutex<tray_effects::Appearance>,
    transition_id: AtomicU64,
    transitioning: AtomicBool,
    rest_position: Mutex<Option<tauri::PhysicalPosition<i32>>>,
    appearance_initialized: AtomicBool,
    warming: AtomicBool,
    full_width: std::sync::atomic::AtomicI32,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            snapshot: Mutex::new(TraySnapshot {
                quota: codex_usage::CodexQuota::unavailable("正在连接额度服务"),
                phase: "stale".into(),
                stale: false,
                updated_at: None,
            }),
            expanded: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
            last_success: Mutex::new(None),
            appearance: Mutex::new(tray_effects::Appearance::default()),
            transition_id: AtomicU64::new(0),
            transitioning: AtomicBool::new(false),
            rest_position: Mutex::new(None),
            appearance_initialized: AtomicBool::new(false),
            warming: AtomicBool::new(false),
            full_width: std::sync::atomic::AtomicI32::new(0),
        }
    }
}

pub fn active(app: &tauri::AppHandle) -> bool {
    app.state::<IslandState>().tray_mode.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn get_display_mode(app: tauri::AppHandle) -> DisplayMode {
    if active(&app) {
        DisplayMode::Tray
    } else {
        DisplayMode::Capsule
    }
}

#[tauri::command]
pub fn set_startup_mode(app: tauri::AppHandle, mode: DisplayMode) -> Result<(), String> {
    let state = app.state::<IslandState>();
    let mut data = settings::build_settings_data(&state);
    data.startup_mode = mode;
    settings::save_settings_to_file(&data)?;
    *state.startup_mode.lock().unwrap() = mode;
    Ok(())
}

#[tauri::command]
pub fn get_tray_snapshot(state: tauri::State<'_, TrayState>) -> TraySnapshot {
    state.snapshot.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_tray_appearance(state: tauri::State<'_, TrayState>) -> tray_effects::Appearance {
    *state.appearance.lock().unwrap()
}

// A single native read is necessary for geometry diagnostics: separate position /
// size IPC calls can straddle animation frames and report an impossible rectangle.
#[tauri::command]
pub fn get_tray_geometry(app: tauri::AppHandle) -> Result<(i32, i32, i32, i32), String> {
    let panel = app
        .get_webview_window("codex-tray")
        .ok_or("托盘窗口不可用")?;
    let hwnd = panel.hwnd().map_err(|e| e.to_string())?;
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect) }
        .map_err(|e| e.to_string())?;
    Ok((
        rect.left,
        rect.top,
        rect.right - rect.left,
        rect.bottom - rect.top,
    ))
}

fn sync_appearance(
    app: &tauri::AppHandle,
    panel: &tauri::WebviewWindow,
) -> tray_effects::Appearance {
    let state = app.state::<TrayState>();
    let previous = state
        .appearance_initialized
        .load(Ordering::SeqCst)
        .then(|| *state.appearance.lock().unwrap());
    let appearance = tray_effects::apply(panel, previous);
    state.appearance_initialized.store(true, Ordering::SeqCst);
    *app.state::<TrayState>().appearance.lock().unwrap() = appearance;
    let _ = panel.emit("tray-appearance", appearance);
    appearance
}

fn report_error(app: &tauri::AppHandle, error: String) {
    crate::logger::error("Tray", &error);
    let _ = app.emit("tray-error", error);
}

pub fn switch_mode(app: &tauri::AppHandle, mode: DisplayMode) -> Result<(), String> {
    let main = app.get_webview_window("main").ok_or("胶囊窗口不可用")?;
    app.get_webview_window("codex-tray")
        .ok_or("托盘窗口正在初始化，请稍后再试")?;
    let state = app.state::<IslandState>();
    match mode {
        DisplayMode::Tray => {
            hide_details(app)?;
            state.tray_mode.store(true, Ordering::Relaxed);
            if let Err(error) = main.hide() {
                state.tray_mode.store(false, Ordering::Relaxed);
                return Err(error.to_string());
            }
            publish(app);
        }
        DisplayMode::Capsule => {
            hide_details(app)?;
            state.tray_mode.store(false, Ordering::Relaxed);
            main.show().map_err(|error| error.to_string())?;
            if let Some(tray) = app.tray_by_id("wisland") {
                let _ = tray.set_icon(Some(
                    Image::from_bytes(include_bytes!("../icons/32x32.png"))
                        .map_err(|e| e.to_string())?,
                ));
                let _ = tray.set_tooltip(Some("Wisland"));
            }
        }
    }
    if let Some(tray) = app.tray_by_id("wisland") {
        tray.set_menu(Some(build_tray_menu(app, mode).map_err(|e| e.to_string())?))
            .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("display-mode-changed", mode);
    Ok(())
}

#[tauri::command]
pub async fn set_display_mode(app: tauri::AppHandle, mode: DisplayMode) -> Result<(), String> {
    switch_mode(&app, mode)
}

// Physical coordinates, including negative origins on secondary monitors.
fn sidebar_bounds(
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    scale: f64,
) -> (i32, i32, u32, u32) {
    let width = ((525.0 * scale).round() as i32).min(right - left).max(1);
    (
        right - width,
        top,
        width as u32,
        (bottom - top).max(1) as u32,
    )
}

struct PanelPlacement {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
    clip_right: i32,
}

fn panel_placement(app: &tauri::AppHandle) -> Result<PanelPlacement, String> {
    let panel = app
        .get_webview_window("codex-tray")
        .ok_or("托盘窗口不可用")?;
    // Shell's actual icon rectangle locates the correct monitor, including overflow trays.
    let anchor = app
        .tray_by_id("wisland")
        .and_then(|tray| tray.rect().ok().flatten());
    let monitor = if let Some(rect) = &anchor {
        let p = rect.position.to_physical::<i32>(1.0);
        panel
            .monitor_from_point(p.x as f64, p.y as f64)
            .ok()
            .flatten()
    } else {
        None
    }
    .or_else(|| panel.primary_monitor().ok().flatten())
    .ok_or("无法定位显示器")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let bottom = tray_effects::taskbar_top(
        windows::Win32::Foundation::RECT {
            left: monitor.position().x,
            top: monitor.position().y,
            right: monitor.position().x + monitor.size().width as i32,
            bottom: monitor.position().y + monitor.size().height as i32,
        },
        area.position.y + area.size.height as i32,
    );
    let right = area.position.x + area.size.width as i32;
    let (_, y, width, height) =
        sidebar_bounds(area.position.x, area.position.y, right, bottom, scale);
    // Tauri set_size takes CLIENT size; undecorated Windows windows still have
    // invisible resize margins. Include those in placement and subtract them
    // from available height, otherwise the final frame extends into the taskbar.
    let outer = panel.outer_size().map_err(|e| e.to_string())?;
    let inner = panel.inner_size().map_err(|e| e.to_string())?;
    let current_scale = panel.scale_factor().map_err(|e| e.to_string())?;
    let frame_w =
        (outer.width.saturating_sub(inner.width) as f64 * scale / current_scale).round() as u32;
    let frame_h =
        (outer.height.saturating_sub(inner.height) as f64 * scale / current_scale).round() as u32;
    let x = right - (width + frame_w) as i32;
    Ok(PanelPlacement {
        position: tauri::PhysicalPosition::new(x, y),
        size: tauri::PhysicalSize::new(width, height.saturating_sub(frame_h).max(1)),
        clip_right: right,
    })
}

fn position_panel(app: &tauri::AppHandle) -> Result<(), String> {
    let panel = app
        .get_webview_window("codex-tray")
        .ok_or("托盘窗口不可用")?;
    let placement = panel_placement(app)?;
    panel.set_size(placement.size).map_err(|e| e.to_string())?;
    app.state::<TrayState>().full_width.store(
        panel.outer_size().map_err(|e| e.to_string())?.width as i32,
        Ordering::SeqCst,
    );
    panel
        .set_position(placement.position)
        .map_err(|e| e.to_string())?;
    *app.state::<TrayState>().rest_position.lock().unwrap() = Some(placement.position);
    Ok(())
}

// Called on the UI thread by the shared display watcher. Never opens a hidden sidebar.
pub(crate) fn display_changed(app: &tauri::AppHandle) {
    let state = app.state::<TrayState>();
    if state.expanded.load(Ordering::SeqCst) {
        if state.warming.load(Ordering::SeqCst) {
            let _ = request_transition(app, true);
        } else {
            state.transition_id.fetch_add(1, Ordering::SeqCst);
            state.transitioning.store(false, Ordering::SeqCst);
            if let Err(error) = position_panel(app) {
                report_error(app, error);
            }
        }
    } else if state.transitioning.load(Ordering::SeqCst) {
        let _ = hide_details(app);
    }
}

fn hide_details(app: &tauri::AppHandle) -> Result<(), String> {
    // Mode changes hide immediately and invalidate any queued entrance/exit animation.
    app.state::<TrayState>()
        .transition_id
        .fetch_add(1, Ordering::SeqCst);
    app.state::<TrayState>()
        .expanded
        .store(false, Ordering::Relaxed);
    app.state::<TrayState>()
        .transitioning
        .store(false, Ordering::SeqCst);
    if let Some(panel) = app.get_webview_window("codex-tray") {
        panel.hide().map_err(|error| error.to_string())?;
        let _ = tray_effects::cloak(&panel, false);
    }
    app.state::<TrayState>()
        .warming
        .store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn set_tray_expanded(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    request_transition(&app, expanded)
}

fn request_transition(app: &tauri::AppHandle, open: bool) -> Result<(), String> {
    if open && !active(app) {
        return Ok(());
    }
    let state = app.state::<TrayState>();
    let id = state.transition_id.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<TrayState>();
        if state.transition_id.load(Ordering::SeqCst) != id || (open && !active(&handle)) {
            return;
        }
        if let Err(error) = begin_transition(&handle, id, open) {
            report_error(&handle, error);
            let _ = hide_details(&handle);
        }
    })
    .map_err(|error| error.to_string())
}

// All window operations below run on the owning UI thread. The timer never blocks it.
fn begin_transition(app: &tauri::AppHandle, id: u64, open: bool) -> Result<(), String> {
    let state = app.state::<TrayState>();
    let panel = app
        .get_webview_window("codex-tray")
        .ok_or("托盘窗口不可用")?;
    let visible = panel.is_visible().map_err(|e| e.to_string())?;
    if state.warming.load(Ordering::SeqCst) {
        hide_details(app)?;
        return if open {
            request_transition(app, true)
        } else {
            Ok(())
        };
    }
    let was_transitioning = state.transitioning.swap(true, Ordering::SeqCst);
    state.expanded.store(open, Ordering::SeqCst);
    if !open && !visible {
        state.transitioning.store(false, Ordering::SeqCst);
        return Ok(());
    }
    let appearance = sync_appearance(app, &panel);
    let placement = panel_placement(app)?;
    let current = panel.outer_position().map_err(|e| e.to_string())?;
    let rest = if open {
        if !visible || !was_transitioning {
            panel.set_size(placement.size).map_err(|e| e.to_string())?;
            state.full_width.store(
                panel.outer_size().map_err(|e| e.to_string())?.width as i32,
                Ordering::SeqCst,
            );
        }
        *state.rest_position.lock().unwrap() = Some(placement.position);
        placement.position
    } else {
        state.rest_position.lock().unwrap().unwrap_or(current)
    };
    let slide = tray_effects::Slide {
        y: rest.y,
        from_x: if visible {
            current.x
        } else {
            placement.clip_right - tray_effects::minimum_viewport_width(&panel)?
        },
        to_x: if open { rest.x } else { placement.clip_right },
        open,
    };
    let motion = appearance.motion && (!open || !visible || was_transitioning);
    if open && !visible {
        // WS_VISIBLE alone does not mean the acrylic/WebView surface has presented.
        // Compose a full-size surface behind DWM's cloak before exposing any pixels.
        tray_effects::cloak(&panel, true)?;
        state.warming.store(true, Ordering::SeqCst);
        panel.set_position(rest).map_err(|e| e.to_string())?;
        // Prepare the exact first visible viewport before composition, rather than
        // warming a full-size surface and then invalidating it just before show.
        tray_effects::reveal(
            &panel,
            slide.position(if motion { 0.0 } else { 1.0 }),
            placement.clip_right,
            state.full_width.load(Ordering::SeqCst),
            false,
        )?;
        panel.show().map_err(|e| e.to_string())?;
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            tray_effects::wait_for_composition();
            tray_effects::wait_for_composition();
            let scheduled = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                let state = scheduled.state::<TrayState>();
                if state.transition_id.load(Ordering::SeqCst) != id {
                    return;
                }
                let result = (|| -> Result<(), String> {
                    tray_effects::reveal(
                        &panel,
                        slide.position(if motion { 0.0 } else { 1.0 }),
                        placement.clip_right,
                        state.full_width.load(Ordering::SeqCst),
                        true,
                    )?;
                    state.warming.store(false, Ordering::SeqCst);
                    if motion {
                        animate_slide(scheduled.clone(), id, slide, placement.clip_right);
                    } else {
                        finish_transition(&scheduled, id, true)?;
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    report_error(&scheduled, error);
                    let _ = hide_details(&scheduled);
                }
            });
        });
        return Ok(());
    }
    if open {
        // Place the hidden window before showing it; never expose its old location.
        tray_effects::reveal(
            &panel,
            slide.position(if motion { 0.0 } else { 1.0 }),
            placement.clip_right,
            state.full_width.load(Ordering::SeqCst),
            true,
        )?;
        panel.show().map_err(|e| e.to_string())?;
        panel.set_focus().map_err(|e| e.to_string())?;
    }
    if !motion || slide.from_x == slide.to_x {
        return finish_transition(app, id, open);
    }
    animate_slide(app.clone(), id, slide, placement.clip_right);
    Ok(())
}

fn finish_transition(app: &tauri::AppHandle, id: u64, open: bool) -> Result<(), String> {
    let state = app.state::<TrayState>();
    if state.transition_id.load(Ordering::SeqCst) != id {
        return Ok(());
    }
    let panel = app
        .get_webview_window("codex-tray")
        .ok_or("托盘窗口不可用")?;
    if open {
        // Re-read the work area in case display settings changed during the slide.
        position_panel(app)?;
    } else {
        panel.hide().map_err(|e| e.to_string())?;
    }
    state.transitioning.store(false, Ordering::SeqCst);
    if open {
        if tray_effects::is_foreground(&panel) {
            let _ = panel.emit("tray-expanded", true);
        }
    }
    Ok(())
}

fn animate_slide(app: tauri::AppHandle, id: u64, slide: tray_effects::Slide, clip_right: i32) {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        loop {
            let handle = app.clone();
            let (sent, received) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    let progress =
                        (started.elapsed().as_secs_f64() / slide.duration().as_secs_f64()).min(1.0);
                    if handle
                        .state::<TrayState>()
                        .transition_id
                        .load(Ordering::SeqCst)
                        != id
                    {
                        let _ = sent.send(false);
                        return;
                    }
                    let result = handle
                        .get_webview_window("codex-tray")
                        .ok_or_else(|| "托盘窗口不可用".to_string())
                        .and_then(|panel| {
                            tray_effects::reveal(
                                &panel,
                                slide.position(progress),
                                clip_right,
                                handle
                                    .state::<TrayState>()
                                    .full_width
                                    .load(Ordering::SeqCst),
                                slide.open,
                            )
                        })
                        .and_then(|()| {
                            if progress >= 1.0 {
                                finish_transition(&handle, id, slide.open)
                            } else {
                                Ok(())
                            }
                        });
                    if let Err(error) = result {
                        report_error(&handle, error);
                        let _ = hide_details(&handle);
                        let _ = sent.send(false);
                    } else {
                        let _ = sent.send(progress < 1.0);
                    }
                })
                .is_err()
            {
                break;
            }
            // One outstanding frame at most; canceled animations cannot move or hide
            // a newer popup, including after switching back to capsule mode.
            if !received.blocking_recv().unwrap_or(false) {
                break;
            }
            tray_effects::wait_for_composition();
        }
    });
}

#[tauri::command]
pub async fn refresh_tray_quota(app: tauri::AppHandle) -> TraySnapshot {
    let state = app.state::<TrayState>();
    if state.refreshing.swap(true, Ordering::Relaxed) {
        return state.snapshot.lock().unwrap().clone();
    }
    let quota = codex_usage::get_codex_quota().await;
    {
        let mut last_success = state.last_success.lock().unwrap();
        let mut snapshot = state.snapshot.lock().unwrap();
        if quota.available {
            *last_success = Some(Instant::now());
            snapshot.updated_at = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            );
            snapshot.quota = quota;
            snapshot.stale = false;
        } else if last_success.is_some_and(|time| time.elapsed() < Duration::from_secs(6 * 3600)) {
            snapshot.stale = true;
        } else {
            snapshot.quota = quota;
            snapshot.stale = false;
            snapshot.updated_at = None;
        }
    }
    state.refreshing.store(false, Ordering::Relaxed);
    if active(&app) {
        publish(&app);
    }
    let snapshot = state.snapshot.lock().unwrap().clone();
    snapshot
}

fn status_color(phase: &str) -> [u8; 3] {
    match phase {
        "running" => [243, 165, 43],
        "idle" | "completed" => [121, 221, 24],
        _ => [116, 121, 130],
    }
}

fn ring_icon(snapshot: &TraySnapshot) -> Image<'static> {
    let color = status_color(&snapshot.phase);
    let weekly = snapshot.quota.weekly.as_ref().map(|v| v.remaining_percent);
    let five = snapshot
        .quota
        .five_hour
        .as_ref()
        .map(|v| v.remaining_percent);
    let rings = if five.is_some() && weekly.is_some() {
        vec![(12.5, weekly), (8.0, five)]
    } else {
        vec![(12.5, weekly.or(five))]
    };
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let mut alpha = 0.0f64;
            for sy in 0..4 {
                for sx in 0..4 {
                    let dx = x as f64 + (sx as f64 + 0.5) / 4.0 - 16.0;
                    let dy = y as f64 + (sy as f64 + 0.5) / 4.0 - 16.0;
                    let distance = dx.hypot(dy);
                    let turn = (dy.atan2(dx) + std::f64::consts::FRAC_PI_2)
                        .rem_euclid(std::f64::consts::TAU)
                        / std::f64::consts::TAU;
                    for (radius, remaining) in &rings {
                        if (distance - radius).abs() < 1.4 {
                            alpha +=
                                if remaining.is_some_and(|v| turn < v.clamp(0.0, 100.0) / 100.0) {
                                    255.0
                                } else {
                                    65.0
                                };
                        }
                    }
                }
            }
            let i = (y * 32 + x) * 4;
            pixels[i..i + 3].copy_from_slice(&color);
            pixels[i + 3] = (alpha / 16.0) as u8;
        }
    }
    Image::new_owned(pixels, 32, 32)
}

fn publish(app: &tauri::AppHandle) {
    let snapshot = app.state::<TrayState>().snapshot.lock().unwrap().clone();
    if let Some(tray) = app.tray_by_id("wisland") {
        let _ = tray.set_icon(Some(ring_icon(&snapshot)));
        let mut lines = vec![format!("Codex · {}", snapshot.phase)];
        if let Some(v) = &snapshot.quota.five_hour {
            lines.push(format!("5h: {:.0}%", v.remaining_percent));
        }
        if let Some(v) = &snapshot.quota.weekly {
            lines.push(format!("1w: {:.0}%", v.remaining_percent));
        }
        if !snapshot.quota.available {
            lines.push("额度暂不可用".into());
        }
        if snapshot.stale {
            lines.push("上次成功数据，等待连接恢复".into());
        }
        let _ = tray.set_tooltip(Some(lines.join("\n")));
    }
    // Resizing an already-open popup must never show it again or take focus.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<TrayState>();
        if state.expanded.load(Ordering::Relaxed) && !state.transitioning.load(Ordering::SeqCst) {
            if let Err(error) = position_panel(&handle) {
                report_error(&handle, error);
            }
        }
    });
    let _ = app.emit("tray-snapshot", &snapshot);
}

fn tray_menu_actions(mode: DisplayMode) -> Vec<(&'static str, &'static str)> {
    let mut actions = vec![("capsule", "显示胶囊")];
    if mode == DisplayMode::Capsule {
        actions.push(("tray-mode", "切换至托盘态"));
    }
    actions
}

fn build_tray_menu(
    app: &tauri::AppHandle,
    mode: DisplayMode,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mut menu = MenuBuilder::new(app);
    for (id, label) in tray_menu_actions(mode) {
        menu = menu.item(&MenuItemBuilder::with_id(id, label).build(app)?);
    }
    menu.item(&MenuItemBuilder::with_id("settings", "设置").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "退出").build(app)?)
        .build()
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.manage(TrayState::default());
    let menu = build_tray_menu(app, get_display_mode(app.clone()))?;
    TrayIconBuilder::with_id("wisland")
        .icon(Image::from_bytes(include_bytes!("../icons/32x32.png"))?)
        .menu(&menu)
        .tooltip("Wisland")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "settings" => settings::open_settings(app.clone()),
            "capsule" | "tray-mode" => {
                let mode = if event.id.as_ref() == "capsule" {
                    DisplayMode::Capsule
                } else {
                    DisplayMode::Tray
                };
                if let Err(e) = switch_mode(app, mode) {
                    report_error(app, e);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if active(app) {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = set_tray_expanded(handle.clone(), true).await {
                            report_error(&handle, e);
                        }
                    });
                } else if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }
        })
        .build(app)?;

    // Create WebView2 outside setup / IPC to avoid the second-window deadlock.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        let panel = tauri::WebviewWindowBuilder::new(
            &handle,
            "codex-tray",
            tauri::WebviewUrl::App("tray.html".into()),
        )
        .title("Wisland · Codex")
        .inner_size(525.0, 700.0)
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .shadow(true)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
        match panel {
            Ok(panel) => {
                let material_panel = panel.clone();
                let material_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(error) = tray_effects::keep_material_active(&material_panel) {
                        report_error(&material_handle, error);
                    }
                    sync_appearance(&material_handle, &material_panel);
                });
                let handle_focus = handle.clone();
                panel.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Alt+F4 must not destroy the only route back from a hidden capsule.
                        api.prevent_close();
                    }
                    // A monitoring sidebar remains open when another application gains focus.
                    let dismiss = matches!(event, tauri::WindowEvent::CloseRequested { .. });
                    if dismiss
                        && handle_focus
                            .state::<TrayState>()
                            .expanded
                            .load(Ordering::Relaxed)
                    {
                        if let Err(e) = request_transition(&handle_focus, false) {
                            report_error(&handle_focus, e);
                        }
                    }
                    if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
                        if let Some(panel) = handle_focus.get_webview_window("codex-tray") {
                            sync_appearance(&handle_focus, &panel);
                        }
                    }
                });
                let mode = *handle.state::<IslandState>().startup_mode.lock().unwrap();
                if let Err(e) = switch_mode(&handle, mode) {
                    report_error(&handle, e);
                }
            }
            Err(e) => {
                handle
                    .state::<IslandState>()
                    .tray_mode
                    .store(false, Ordering::Relaxed);
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.show();
                }
                report_error(&handle, e.to_string());
            }
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_poll = None::<Instant>;
        let mut last_phase = String::new();
        loop {
            if active(&handle) {
                let phase = agent_status::get_codex_status().phase;
                handle.state::<TrayState>().snapshot.lock().unwrap().phase = phase.clone();
                if phase != last_phase {
                    last_phase = phase;
                    publish(&handle);
                }
                if last_poll.is_none_or(|t| t.elapsed() >= Duration::from_secs(120)) {
                    last_poll = Some(Instant::now());
                    let refresh_handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        refresh_tray_quota(refresh_handle).await;
                    });
                }
            } else {
                last_poll = None;
                last_phase.clear();
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_mode_defaults_and_validates() {
        let settings: settings::SettingsData = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.startup_mode, DisplayMode::Capsule);
        let settings: settings::SettingsData =
            serde_json::from_str(r#"{"startup_mode":"tray"}"#).unwrap();
        assert_eq!(settings.startup_mode, DisplayMode::Tray);
        assert!(serde_json::from_str::<DisplayMode>(r#""invalid""#).is_err());
    }

    #[test]
    fn tray_status_colors_match_capsule() {
        assert_eq!(status_color("running"), [243, 165, 43]);
        assert_eq!(status_color("completed"), status_color("idle"));
        assert_eq!(status_color("stale"), [116, 121, 130]);
    }

    #[test]
    fn sidebar_uses_work_area_and_dpi_including_negative_origins() {
        assert_eq!(sidebar_bounds(0, 0, 1920, 1040, 1.0), (1395, 0, 525, 1040));
        assert_eq!(
            sidebar_bounds(-1920, -100, 0, 940, 1.5),
            (-788, -100, 788, 1040)
        );
        assert_eq!(
            sidebar_bounds(0, 40, 1920, 1080, 2.0),
            (870, 40, 1050, 1040)
        );
        assert_eq!(sidebar_bounds(0, 0, 300, 400, 1.0), (0, 0, 300, 400));
    }
    #[test]
    fn tray_mode_menu_does_not_offer_the_current_mode_again() {
        assert!(!tray_menu_actions(DisplayMode::Tray)
            .iter()
            .any(|(id, _)| *id == "tray-mode"));
        assert!(tray_menu_actions(DisplayMode::Tray)
            .iter()
            .any(|(id, _)| *id == "capsule"));
        assert!(tray_menu_actions(DisplayMode::Capsule)
            .iter()
            .any(|(id, _)| *id == "tray-mode"));
    }
}
