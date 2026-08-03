mod agent_status;
mod cc;
mod codex_usage;
pub mod logger;
mod lyrics;
mod media;
mod obsidian;
mod onboarding;
mod privacy;
pub mod settings;
mod window;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use windows::Win32::Foundation::HWND;

pub(crate) const WIN_W: f64 = 560.0; // 容纳 1.5× 展开胶囊，外围透明区域自动穿透
pub(crate) const TOP_MARGIN: f64 = 0.0;

// ── 胶囊尺寸（与 base.css :root 变量对应） ──
pub(crate) const CAPSULE_COLLAPSED_W: f64 = 140.0; // CSS --collapsed-w
pub(crate) const CAPSULE_COLLAPSED_H: f64 = 50.0; // CSS --collapsed-h
pub(crate) const CAPSULE_LYRIC_W: f64 = 190.0; // CSS --lyric-collapsed-w
pub(crate) const CAPSULE_JOURNAL_W: f64 = 250.0; // CSS --journal-collapsed-w
pub(crate) const CAPSULE_TRAY_W: f64 = 190.0; // CSS view-tray
pub(crate) const CAPSULE_EXPANDED_W: f64 = 330.0; // CSS --expanded-w
pub(crate) const CAPSULE_EXPANDED_H: f64 = 74.0; // CSS --expanded-h
pub(crate) const CAPSULE_TOP_PAD: f64 = 5.0; // body padding-top

pub(crate) const WIN_H_DEFAULT: f64 = 84.0; // CAPSULE_EXPANDED_H + padding

// 收起态小横条的视觉/命中尺寸；原生窗口保持 WIN_W，避免宽度动画产生水平抖动。
pub(crate) const MINIMIZED_W: f64 = 70.0;
pub(crate) const MINIMIZED_H: f64 = 12.0;

pub(crate) const SNAP_DURATION_MS: f64 = 300.0;

pub(crate) const SNAP_FRAME_MS: u64 = 10;
pub(crate) const CAPSULE_TRANSITION_MS: u64 = 350; // Matches the capsule CSS transition.
const CAPSULE_LEAVE_DELAY_MS: u64 = 500;
const PRIVACY_POLL_MS: u64 = 1200;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            window::start_drag, window::end_drag, window::drag_move,
            window::dismiss_island, window::set_current_view, window::set_interacting,
            window::get_is_expanded, window::toggle_capsule_pin,
            window::sync_window_height, window::sync_window_size, window::set_minimized, window::show_context_menu,
            window::set_music_expanded,
            settings::open_settings, settings::get_settings, settings::set_core_preferences,
            settings::open_github_profile,
            settings::set_appearance_preferences,
            settings::get_lyric_offset_players, settings::set_lyric_offset_enabled,
            settings::set_lyric_offset_for_player, settings::delete_lyric_offset_player,
            settings::set_obsidian_preferences,
            agent_status::get_codex_status, agent_status::clear_codex_status,
            agent_status::install_codex_status_hooks,
            codex_usage::get_codex_quota, codex_usage::connect_codex_quota,
            codex_usage::get_codex_cli_status,
            onboarding::get_onboarding_status, onboarding::open_onboarding_window,
            onboarding::complete_onboarding,
            obsidian::append_obsidian_note, obsidian::append_obsidian_entry,
            obsidian::get_obsidian_todos, obsidian::get_obsidian_entries,
            obsidian::set_obsidian_todo_completed, obsidian::delete_obsidian_entry,
            window::open_staged_file,
            media::media_play_pause, media::media_next, media::media_prev,
            media::media_seek,
            media::media_volume_up, media::media_volume_down,
            media::media_get_volume, media::media_set_volume,
            media::diagnose_smtc_sessions,
            settings::get_auto_start, settings::set_auto_start,
            settings::get_blacklist, settings::save_blacklist,
            settings::get_blacklist_enabled, settings::set_blacklist_enabled,
            settings::get_smtc_whitelist, settings::save_smtc_whitelist,
            settings::get_smtc_whitelist_enabled, settings::set_smtc_whitelist_enabled,
            logger::get_log_path, logger::open_log_dir,
            logger::get_log_level, logger::set_log_level,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            // Explicit WM_SETICON data keeps Task Manager from reusing the former Eisland icon.
            window.set_icon(Image::from_bytes(include_bytes!("../icons/icon.png"))?)?;

            let scale = window.scale_factor().unwrap_or(1.0);
            let screen_w = if let Ok(Some(monitor)) = window.current_monitor() {
                monitor.size().width as f64 / monitor.scale_factor()
            } else { 1920.0 };

            let home_x = (screen_w - WIN_W) / 2.0;
            let _ = window.set_position(tauri::LogicalPosition::new(home_x, TOP_MARGIN));
            let _ = window.set_size(tauri::LogicalSize::new(WIN_W, WIN_H_DEFAULT));

            let hwnd = HWND(window.hwnd().unwrap().0);
            window::set_click_through(hwnd, true);

            let is_expanded = Arc::new(AtomicBool::new(false));
            let is_notifying = Arc::new(AtomicBool::new(false));
            let is_dragging = Arc::new(AtomicBool::new(false));
            let is_interacting = Arc::new(AtomicBool::new(false));
            let is_pinned_expanded = Arc::new(AtomicBool::new(false));
            let suppress_auto_expand = Arc::new(AtomicBool::new(false));

            // 从文件加载设置
            let settings = settings::load_settings_from_file();
            logger::set_level(&settings.log_level);
            let onboarding_completed = Arc::new(AtomicBool::new(settings.onboarding_completed));
            let lyric_mode = Arc::new(Mutex::new(settings.lyric_mode.clone()));
            let lyric_offset_enabled = Arc::new(AtomicBool::new(settings.lyric_offset_enabled));
            // 按播放器存储的歌词补偿，启动时规范化键值
            let lyric_offsets_by_player: Arc<Mutex<std::collections::HashMap<String, i64>>> =
                Arc::new(Mutex::new(settings::normalize_lyric_offsets(&settings.lyric_offsets_by_player)));
            // 当前命中播放器 app_id（供 settings 子页高亮）
            let active_player_app_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let current_view = Arc::new(Mutex::new("time".to_string()));
            let music_expanded = Arc::new(AtomicBool::new(false));
            let is_minimized = Arc::new(AtomicBool::new(false));
            let expand_anim_id = Arc::new(AtomicU64::new(0));
            let indicator_color = Arc::new(Mutex::new(settings.indicator_color.clone()));
            let capsule_opacity = Arc::new(Mutex::new(settings.capsule_opacity));
            let capsule_scale = Arc::new(Mutex::new(settings.capsule_scale));
            let icon_bar_style = Arc::new(Mutex::new(settings.icon_bar_style.clone()));
            let icon_bar_order = Arc::new(Mutex::new(settings.icon_bar_order.clone()));
            let border_effect = Arc::new(Mutex::new(settings.border_effect.clone()));
            let border_custom_source = Arc::new(Mutex::new(settings.border_custom_source.clone()));
            let left_visual_mode = Arc::new(Mutex::new(settings.left_visual_mode.clone()));
            let left_visual_source = Arc::new(Mutex::new(settings.left_visual_source.clone()));
            let right_visual_mode = Arc::new(Mutex::new(settings.right_visual_mode.clone()));
            let right_visual_source = Arc::new(Mutex::new(settings.right_visual_source.clone()));
            let visual_assets = Arc::new(Mutex::new(settings.visual_assets.clone()));
            let border_assets = Arc::new(Mutex::new(settings.border_assets.clone()));
            let rainbow_border = Arc::new(AtomicBool::new(settings.rainbow_border));
            let auto_start = Arc::new(AtomicBool::new(settings.auto_start));
            let blacklist_processes: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(
                settings.blacklist_processes.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
            ));
            let blacklist_enabled = Arc::new(AtomicBool::new(settings.blacklist_enabled));
            let smtc_app_whitelist: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(
                settings.smtc_app_whitelist.iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
            ));
            let smtc_whitelist_enabled = Arc::new(AtomicBool::new(settings.smtc_whitelist_enabled));
            let cc_routes: Arc<Mutex<Vec<cc::CcRoute>>> = Arc::new(Mutex::new(settings.cc.clone()));
            let obsidian_vault_path = Arc::new(Mutex::new(settings.obsidian_vault_path.clone()));
            let obsidian_daily_notes_dir = Arc::new(Mutex::new(settings.obsidian_daily_notes_dir.clone()));
            let is_music = Arc::new(AtomicBool::new(false));

            media::update_smtc_whitelist(
                smtc_whitelist_enabled.load(Ordering::Relaxed),
                smtc_app_whitelist.lock().unwrap().clone(),
            );
            media::start_audio_peak_monitor(window.clone(), is_music.clone());

            app.manage(IslandState {
                onboarding_completed: onboarding_completed.clone(),
                is_notifying: is_notifying.clone(),
                is_expanded: is_expanded.clone(),
                is_dragging: is_dragging.clone(),
                is_interacting: is_interacting.clone(),
                is_pinned_expanded: is_pinned_expanded.clone(),
                suppress_auto_expand: suppress_auto_expand.clone(),
                lyric_mode: lyric_mode.clone(),
                lyric_offset_enabled: lyric_offset_enabled.clone(),
                lyric_offsets_by_player: lyric_offsets_by_player.clone(),
                active_player_app_id: active_player_app_id.clone(),
                current_view: current_view.clone(),
                music_expanded: music_expanded.clone(),
                is_minimized: is_minimized.clone(),
                expand_anim_id: expand_anim_id.clone(),
                screen_w,
                indicator_color: indicator_color.clone(),
                capsule_opacity: capsule_opacity.clone(),
                capsule_scale: capsule_scale.clone(),
                icon_bar_style: icon_bar_style.clone(),
                icon_bar_order: icon_bar_order.clone(),
                border_effect: border_effect.clone(),
                border_custom_source: border_custom_source.clone(),
                left_visual_mode: left_visual_mode.clone(),
                left_visual_source: left_visual_source.clone(),
                right_visual_mode: right_visual_mode.clone(),
                right_visual_source: right_visual_source.clone(),
                visual_assets: visual_assets.clone(),
                border_assets: border_assets.clone(),
                rainbow_border: rainbow_border.clone(),
                auto_start: auto_start.clone(),
                blacklist_processes: blacklist_processes.clone(),
                blacklist_enabled: blacklist_enabled.clone(),
                smtc_app_whitelist: smtc_app_whitelist.clone(),
                smtc_whitelist_enabled: smtc_whitelist_enabled.clone(),
                cc_routes: cc_routes.clone(),
                obsidian_vault_path: obsidian_vault_path.clone(),
                obsidian_daily_notes_dir: obsidian_daily_notes_dir.clone(),
            });

            // --- 系统托盘 ---
            let app_handle = app.handle().clone();
            let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "设置").build(app)?;
            let menu = MenuBuilder::new(app).item(&settings_item).item(&quit_item).build()?;
            let tray_image = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            let _tray = TrayIconBuilder::new()
                .icon(tray_image)
                .menu(&menu).tooltip("Wisland")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "quit" => app_handle.exit(0),
                        "settings" => {
                            settings::open_settings(app.clone());
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // --- 鼠标监控线程 ---
            let win_m = window.clone();
            let noti_m = is_notifying.clone();
            let exp_m = is_expanded.clone();
            let drag_m = is_dragging.clone();
            let interact_m = is_interacting.clone();
            let pinned_m = is_pinned_expanded.clone();
            let suppress_expand_m = suppress_auto_expand.clone();
            let lyric_mode_m = lyric_mode.clone();
            let current_view_m = current_view.clone();
            let music_expanded_m = music_expanded.clone();
            let expand_anim_id_m = expand_anim_id.clone();
            let is_minimized_m = is_minimized.clone();
            let capsule_scale_m = capsule_scale.clone();
            let hwnd_raw = hwnd.0 as usize;
            let is_music_m = is_music.clone();

            thread::spawn(move || {
                let hwnd = HWND(hwnd_raw as *mut _);
                let mut was_on_capsule = false;
                let mut left_capsule_at: Option<Instant> = None;

                loop {
                    if let Some((mx, my)) = window::get_cursor_pos() {
                        // 根据当前状态确定胶囊宽度
                        let expanded = exp_m.load(Ordering::Relaxed);
                        let music_exp = music_expanded_m.load(Ordering::Relaxed);
                        let view = current_view_m.lock().unwrap().clone();
                        let lyric_mode = lyric_mode_m.lock().unwrap().clone();
                        let appearance_scale = *capsule_scale_m.lock().unwrap();
                        // 直接用实际窗口矩形判断鼠标是否在胶囊上
                        let rect = window::get_window_rect(hwnd);
                        let on_capsule = if let Some(rect) = rect {
                            let win_w = (rect.right - rect.left) as f64 / scale;
                            let win_h = (rect.bottom - rect.top) as f64 / scale;

                            let minimized = is_minimized_m.load(Ordering::Relaxed);
                            let (cw, ch, radius) = if minimized {
                                (MINIMIZED_W, MINIMIZED_H, MINIMIZED_H / 2.0)
                            } else if music_exp && view == "lyric" {
                                // 音乐大面板：占满窗口
                                (win_w, win_h, 28.0)
                            } else if expanded {
                                (CAPSULE_EXPANDED_W, CAPSULE_EXPANDED_H, 28.0)
                            } else if view == "lyric" && is_music_m.load(Ordering::Relaxed) && lyric_mode != "off" {
                                (CAPSULE_LYRIC_W, CAPSULE_COLLAPSED_H, CAPSULE_COLLAPSED_H / 2.0)
                            } else if view == "lyric" {
                                (CAPSULE_LYRIC_W, CAPSULE_COLLAPSED_H, CAPSULE_COLLAPSED_H / 2.0)
                            } else if view == "journal" {
                                (CAPSULE_JOURNAL_W, CAPSULE_COLLAPSED_H, CAPSULE_COLLAPSED_H / 2.0)
                            } else if view == "tray" {
                                (CAPSULE_TRAY_W, CAPSULE_COLLAPSED_H, CAPSULE_COLLAPSED_H / 2.0)
                            } else {
                                // time 等收起态
                                (CAPSULE_COLLAPSED_W, CAPSULE_COLLAPSED_H, CAPSULE_COLLAPSED_H / 2.0)
                            };
                            let (cw, ch, radius) = if minimized || music_exp {
                                (cw, ch, radius)
                            } else {
                                (cw * appearance_scale, ch * appearance_scale, radius * appearance_scale)
                            };

                            let win_x = rect.left as f64;
                            let win_y = rect.top as f64;
                            let capsule_x = win_x + (win_w * scale - cw * scale) / 2.0;
                            let capsule_y = win_y + CAPSULE_TOP_PAD * scale;
                            let fmx = mx as f64;
                            let fmy = my as f64;
                            window::point_in_rounded_rect(
                                fmx,
                                fmy,
                                capsule_x,
                                capsule_y,
                                cw * scale,
                                ch * scale,
                                radius * scale,
                            )
                        } else { false };

                        if on_capsule && !was_on_capsule {
                            logger::debug("HitTest", "mouse ON capsule -> click-through OFF");
                            window::set_click_through(hwnd, false);
                            was_on_capsule = true;
                        } else if !on_capsule && was_on_capsule {
                            logger::debug("HitTest", "mouse OFF capsule -> click-through ON");
                            window::set_click_through(hwnd, true);
                            was_on_capsule = false;
                        }

                        if !music_exp && !is_minimized_m.load(Ordering::Relaxed) && !noti_m.load(Ordering::Relaxed) && !drag_m.load(Ordering::Relaxed) && !interact_m.load(Ordering::Relaxed) && !pinned_m.load(Ordering::Relaxed) {
                            if on_capsule {
                                left_capsule_at = None;
                            } else {
                                suppress_expand_m.store(false, Ordering::Relaxed);
                            }

                            if on_capsule && !suppress_expand_m.load(Ordering::Relaxed) && !exp_m.load(Ordering::Relaxed) {
                                let gen = expand_anim_id_m.fetch_add(1, Ordering::Relaxed) + 1;
                                let expanded_window_h = CAPSULE_EXPANDED_H * appearance_scale + 10.0;
                                window::stage_capsule_window_height(
                                    hwnd,
                                    scale,
                                    expanded_window_h,
                                    WIN_W,
                                    true,
                                    expand_anim_id_m.clone(),
                                    gen,
                                );
                                exp_m.store(true, Ordering::Relaxed);
                                let _ = win_m.emit("set-expand", true);
                            } else if !on_capsule && exp_m.load(Ordering::Relaxed) {
                                let left_at = left_capsule_at.get_or_insert_with(Instant::now);
                                if left_at.elapsed() < Duration::from_millis(CAPSULE_LEAVE_DELAY_MS) {
                                    thread::sleep(Duration::from_millis(16));
                                    continue;
                                }
                                left_capsule_at = None;
                                exp_m.store(false, Ordering::Relaxed);
                                let _ = win_m.emit("set-expand", false);
                                let gen = expand_anim_id_m.fetch_add(1, Ordering::Relaxed) + 1;
                                let collapsed_h = CAPSULE_COLLAPSED_H * appearance_scale + 10.0;
                                window::stage_capsule_window_height(
                                    hwnd,
                                    scale,
                                    collapsed_h,
                                    WIN_W,
                                    false,
                                    expand_anim_id_m.clone(),
                                    gen,
                                );
                            } else if !on_capsule {
                                left_capsule_at = None;
                            }
                        } else {
                            left_capsule_at = None;
                        }
                    }
                    thread::sleep(Duration::from_millis(16));
                }
            });

            // --- 黑名单监控：全屏扫描线程（慢，独立跑，结果存原子变量）---
            let blacklist_fs_cache = Arc::new(AtomicBool::new(false));
            {
                let blacklist = blacklist_processes.clone();
                let bl_enabled = blacklist_enabled.clone();
                let fs_cache = blacklist_fs_cache.clone();
                thread::Builder::new().name("bl-fullscreen-scan".into()).spawn(move || {
                    loop {
                        thread::sleep(Duration::from_millis(800));
                        if !bl_enabled.load(Ordering::Relaxed) {
                            fs_cache.store(false, Ordering::Relaxed);
                            continue;
                        }
                        let list = blacklist.lock().unwrap().clone();
                        let found = if list.is_empty() {
                            false
                        } else {
                            window::is_any_blacklisted_fullscreen(&list)
                        };
                        fs_cache.store(found, Ordering::Relaxed);
                    }
                }).ok();
            }

            // --- 黑名单监控：前台进程检测 + 隐藏/显示线程（快，200ms）---
            {
                let blacklist = blacklist_processes.clone();
                let bl_enabled = blacklist_enabled.clone();
                let fs_cache = blacklist_fs_cache.clone();
                let hwnd_bl = hwnd.0 as usize;
                thread::Builder::new().name("bl-monitor".into()).spawn(move || {
                    let hwnd = HWND(hwnd_bl as *mut _);
                    let mut hidden = false;
                    loop {
                        thread::sleep(Duration::from_millis(200));
                        if !bl_enabled.load(Ordering::Relaxed) {
                            if hidden {
                                unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
                                hidden = false;
                            }
                            continue;
                        }
                        let list = blacklist.lock().unwrap().clone();
                        if list.is_empty() {
                            if hidden {
                                unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
                                hidden = false;
                            }
                            continue;
                        }
                        let fg_match = window::get_foreground_process_name()
                            .map(|n| list.iter().any(|b| n == *b))
                            .unwrap_or(false);
                        let fs_match = fs_cache.load(Ordering::Relaxed);
                        let should_hide = fg_match || fs_match;
                        if should_hide && !hidden {
                            if let Some(ref name) = window::get_foreground_process_name() {
                                crate::logger::info("Blacklist", &format!("hiding island: fg_process='{}'", name));
                            }
                            unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_HIDE); }
                            hidden = true;
                        } else if !should_hide && hidden {
                            crate::logger::info("Blacklist", "showing island: fg_process no longer blacklisted");
                            unsafe { let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
                            hidden = false;
                        }
                    }
                }).ok();
            }

            // --- 麦克风/摄像头使用状态监控 ---
            let win_privacy = window.clone();
            thread::spawn(move || {
                let mut last = privacy::get_privacy_usage_state();
                let _ = win_privacy.emit("privacy-usage", serde_json::json!({
                    "microphone": last.0,
                    "camera": last.1
                }));

                loop {
                    thread::sleep(Duration::from_millis(PRIVACY_POLL_MS));
                    let current = privacy::get_privacy_usage_state();
                    if current != last {
                        last = current;
                        let _ = win_privacy.emit("privacy-usage", serde_json::json!({
                            "microphone": current.0,
                            "camera": current.1
                        }));
                    }
                }
            });

            // --- Claude Code 本地通知服务器 ---
            let win_cc = window.clone();
            let noti_cc = is_notifying.clone();
            let exp_cc = is_expanded.clone();
            let cc_routes_t = cc_routes.clone();
            thread::spawn(move || {
                cc::start_server(win_cc, noti_cc, exp_cc, cc_routes_t);
            });

            // --- 媒体/歌词监控线程 ---
            let win_media = window.clone();
            let lyric_mode_media = lyric_mode.clone();
            let is_music_media = is_music.clone();
            // 歌词补偿：总开关 + 按播放器表 + 当前命中 app_id；以及 AppHandle 用于持久化/广播事件
            let lyric_offset_enabled_media = lyric_offset_enabled.clone();
            let lyric_offsets_media = lyric_offsets_by_player.clone();
            let active_player_media = active_player_app_id.clone();
            let app_handle_media = app.handle().clone();

            // 歌词异步获取：用 Arc<Mutex> 共享结果 + 代数计数器防止竞态
            let lyrics_result: Arc<Mutex<Option<(u64, Vec<lyrics::LyricLine>, bool)>>> = Arc::new(Mutex::new(None));
            // (generation, lyrics, not_found)
            use std::sync::atomic::AtomicU64 as AtomicU64Import;
            let lyrics_generation: Arc<AtomicU64Import> = Arc::new(AtomicU64Import::new(0));
            // 封面代数计数器，防止旧封面覆盖新歌
            let thumb_generation: Arc<AtomicU64Import> = Arc::new(AtomicU64Import::new(0));

            thread::spawn(move || {
                let mut current_lyrics: Vec<lyrics::LyricLine> = Vec::new();
                let mut current_track = String::new();
                let mut last_lyric_text = String::new();
                let mut last_info_track = String::new();
                let mut was_playing = false;
                let mut last_is_playing = false;
                let mut lyrics_not_found = false;
                let mut current_gen: u64 = 0;
                let mut fetch_pending = false; // 当前代是否还在等待结果
                let mut playback_clock = media::PlaybackPositionClock::default();
                // SMTC 会话丢失宽限期：部分播放器（如汽水音乐）在自动切歌瞬间会短暂关闭
                // 并重建会话，若立即发 lyric-update:null 会导致前端从歌词视图回退到时间视图。
                // 轮询周期 250ms，阈值 20 次 ≈ 5s。复用同一个 SMTC manager，
                // 避免常驻运行时反复创建 WinRT manager/异步操作造成内存持续攀升。
                let mut no_session_count: u32 = 0;
                const NO_SESSION_GRACE_CYCLES: u32 = 20;
                let mut smtc_manager = media::create_smtc_manager();

                loop {
                    thread::sleep(Duration::from_millis(250));

                    // 检查异步歌词获取结果（只接受当前代的结果）
                    {
                        let mut result = lyrics_result.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some((gen, ref lyric_lines, not_found)) = result.take() {
                            if gen == current_gen {
                                // 当前代的结果，接受
                                current_lyrics = lyric_lines.clone();
                                lyrics_not_found = not_found;
                                fetch_pending = false;
                                last_lyric_text.clear();
                                last_info_track.clear();
                            }
                            // 旧代的结果直接丢弃（take 已经移除了）
                        }
                    }

                    let mode = lyric_mode_media.lock().unwrap().clone();
                    if mode == "off" {
                        if was_playing {
                            crate::logger::warn("Lyrics", "playback state=stopped reason=lyric_mode_off");
                            was_playing = false;
                            last_is_playing = false;
                            current_track.clear();
                            playback_clock.reset();
                            is_music_media.store(false, Ordering::Relaxed);
                            let _ = win_media.emit("lyric-update", serde_json::json!(null));
                        }
                        continue;
                    }

                    if smtc_manager.is_none() {
                        smtc_manager = media::create_smtc_manager();
                    }
                    let info = smtc_manager
                        .as_ref()
                        .and_then(media::get_smtc_media_info_with_manager);
                    let (status, media_info, position_ms_raw, is_playing, raw_app_id) = match info {
                        Some(v) => {
                            // 拿到有效会话，重置宽限期计数
                            no_session_count = 0;
                            v
                        }
                        None => {
                            if was_playing {
                                // 会话短暂丢失：先走宽限期，避免切歌瞬间被误判为停止播放
                                no_session_count = no_session_count.saturating_add(1);
                                if no_session_count < NO_SESSION_GRACE_CYCLES {
                                    continue;
                                }
                                crate::logger::warn(
                                    "Lyrics",
                                    "playback state=stopped reason=no_smtc_session (grace expired)",
                                );
                                no_session_count = 0;
                                was_playing = false;
                                last_is_playing = false;
                                current_track.clear();
                                playback_clock.reset();
                                is_music_media.store(false, Ordering::Relaxed);
                                let _ = win_media.emit("lyric-update", serde_json::json!(null));
                            }
                            continue;
                        }
                    };
                    // Closed (4) 表示会话已关闭，立即清空状态通知前端
                    if status == 4 {
                        if was_playing {
                            crate::logger::warn("Lyrics", "playback state=stopped reason=smtc_session_closed");
                            was_playing = false;
                            last_is_playing = false;
                            current_track.clear();
                            playback_clock.reset();
                            is_music_media.store(false, Ordering::Relaxed);
                            let _ = win_media.emit("lyric-update", serde_json::json!(null));
                        }
                        continue;
                    }

                    let app_id = settings::normalize_app_id(&raw_app_id);

                    // --- 活跃播放器变化：更新 state 并广播，供 settings 子页高亮 ---
                    {
                        let mut active = active_player_media.lock().unwrap();
                        let changed = active.as_deref() != Some(app_id.as_str());
                        if changed {
                            *active = Some(app_id.clone());
                            drop(active);
                            let _ = app_handle_media.emit(
                                "lyric-offset-active-player-changed",
                                serde_json::json!({ "app_id": app_id }),
                            );
                        }
                    }

                    // --- 自动发现：新播放器首次出现时，默认 0ms 入表并落盘广播 ---
                    let offset_ms = {
                        let needs_insert = !app_id.is_empty() && {
                            let map = lyric_offsets_media.lock().unwrap();
                            !map.contains_key(&app_id)
                        };
                        if needs_insert {
                            {
                                let mut map = lyric_offsets_media.lock().unwrap();
                                map.entry(app_id.clone()).or_insert(0);
                            }
                            // 持久化（通过 Tauri State 访问完整配置）
                            let state_ref = app_handle_media.state::<IslandState>();
                            let data = settings::build_settings_data(&state_ref);
                            if let Err(e) = settings::save_settings_to_file(&data) {
                                crate::logger::warn(
                                    "Lyrics",
                                    &format!("persist lyric_offsets_by_player failed: {}", e),
                                );
                            }
                            let _ = app_handle_media.emit(
                                "lyric-offset-players-changed",
                                serde_json::json!({ "new_app_id": app_id }),
                            );
                        }
                        let map = lyric_offsets_media.lock().unwrap();
                        *map.get(&app_id).unwrap_or(&0)
                    };

                    let offset_enabled = lyric_offset_enabled_media.load(Ordering::Relaxed);
                    let track_key = format!("{} - {}", media_info.artist, media_info.title);
                    let clock_position_ms = playback_clock.update(&track_key, position_ms_raw, is_playing);
                    let position_ms = if offset_enabled {
                        clock_position_ms.saturating_add(offset_ms).max(0)
                    } else {
                        clock_position_ms
                    };

                    // 播放/暂停状态变化
                    if is_playing != last_is_playing {
                        last_is_playing = is_playing;
                        crate::logger::info("Lyrics", &format!(
                            "playback state={} title='{}' artist='{}' genre='{}' position_raw_ms={} position_effective_ms={}",
                            if is_playing { "playing" } else { "paused" },
                            media_info.title,
                            media_info.artist,
                            media_info.genre,
                            position_ms_raw,
                            position_ms
                        ));
                        let _ = win_media.emit("playback-state", is_playing);
                    }

                    is_music_media.store(true, Ordering::Relaxed);

                    if !is_playing {
                        if was_playing {
                            was_playing = false;
                            crate::logger::info("Lyrics", &format!(
                                "playback paused title='{}' artist='{}'",
                                media_info.title, media_info.artist
                            ));
                            let _ = win_media.emit("media-paused", serde_json::json!({
                                "title": media_info.title,
                                "artist": media_info.artist
                            }));
                        }
                        continue;
                    }

                    // 歌曲切换时重新获取歌词
                    if track_key != current_track {
                        crate::logger::info("Lyrics", &format!(
                            "\nsmtc: track changed title='{}' artist='{}' genre='{}' duration_ms={} position_ms={} is_playing={} offset_enabled={} offset_ms={}",
                            media_info.title, media_info.artist, media_info.genre,
                            media_info.duration_ms, position_ms_raw, is_playing,
                            offset_enabled, offset_ms
                        ));
                        current_track = track_key.clone();
                        media::dump_smtc_session("");
                        last_lyric_text.clear();
                        last_info_track.clear();
                        current_lyrics.clear();
                        lyrics_not_found = false;

                        // 递增代数，使旧线程的结果自动失效
                        current_gen = lyrics_generation.fetch_add(1, Ordering::Relaxed) + 1;
                        fetch_pending = false;

                        let _ = win_media.emit("media-changed", serde_json::json!({
                            "title": media_info.title,
                            "artist": media_info.artist,
                            "genre": media_info.genre,
                            "thumbnail": null,
                            "duration_ms": media_info.duration_ms,
                            "seekable": media_info.seekable
                        }));

                        // 异步获取封面（独立线程，不阻塞轮询）
                        {
                            let win_thumb = win_media.clone();
                            let thumb_gen_val = thumb_generation.fetch_add(1, Ordering::Relaxed) + 1;
                            let thumb_gen_ref = thumb_generation.clone();
                            thread::Builder::new()
                                .name("thumb-fetch".into())
                                .spawn(move || {
                                    // 最多重试 3 次，每次间隔递增（150ms / 400ms / 800ms）
                                    let delays = [150u64, 400, 800];
                                    for (i, &delay_ms) in delays.iter().enumerate() {
                                        thread::sleep(std::time::Duration::from_millis(delay_ms));
                                        // 代数已变说明新歌切换，放弃
                                        if thumb_gen_ref.load(Ordering::Relaxed) != thumb_gen_val {
                                            return;
                                        }
                                        if let Some(thumb) = media::get_smtc_thumbnail() {
                                            if thumb_gen_ref.load(Ordering::Relaxed) == thumb_gen_val {
                                                let _ = win_thumb.emit("media-thumbnail", serde_json::json!({
                                                    "thumbnail": thumb
                                                }));
                                            }
                                            return;
                                        }
                                        let _ = i; // suppress unused warning on last iter
                                    }
                                }).ok();
                        }

                        // 异步获取歌词（不阻塞主循环，LRCLIB 和网易云并行）
                        if mode == "lyric" {
                            let title = media_info.title.clone();
                            let artist = media_info.artist.clone();
                            let album_title = media_info.album_title.clone();
                            let album_artist = media_info.album_artist.clone();
                            let duration_ms = media_info.duration_ms;
                            let genre = media_info.genre.clone();
                            let gen = current_gen;
                            let result_ref = lyrics_result.clone();
                            let gen_ref = lyrics_generation.clone();
                            fetch_pending = true;
                            crate::logger::info("Lyrics", &format!(
                                "lyric fetch start gen={} title='{}' artist='{}' genre='{}' strategy=genre_ncmid",
                                gen, title, artist, genre
                            ));
                            thread::Builder::new()
                                .name("lyric-fetch".into())
                                .stack_size(512 * 1024)
                                .spawn(move || {
                                // 提前检查代数
                                if gen_ref.load(Ordering::Relaxed) != gen { return; }
                                let fetched_lyrics = lyrics::fetch_lyrics_parallel(
                                    &title,
                                    &artist,
                                    &album_title,
                                    &album_artist,
                                    &raw_app_id,
                                    duration_ms,
                                    &genre,
                                    gen_ref.clone(),
                                    gen,
                                );
                                // 只有当前代才写入结果；已有 found 结果时不允许被 not_found 覆盖
                                if gen_ref.load(Ordering::Relaxed) == gen {
                                    let not_found = fetched_lyrics.is_none();
                                    let line_count = fetched_lyrics.as_ref().map(|v| v.len()).unwrap_or(0);
                                    let mut guard = result_ref.lock().unwrap_or_else(|e| e.into_inner());
                                    let already_found = guard.as_ref()
                                        .map(|(g, _, nf)| *g == gen && !nf)
                                        .unwrap_or(false);
                                    if already_found && not_found {
                                        crate::logger::warn("Lyrics", &format!(
                                            "lyric fetch skip stale not_found gen={} (already have result)",
                                            gen
                                        ));
                                    } else {
                                        crate::logger::info("Lyrics", &format!(
                                            "lyric fetch done gen={} found={} lines={}",
                                            gen, !not_found, line_count
                                        ));
                                        *guard = Some((gen, fetched_lyrics.unwrap_or_default(), not_found));
                                    }
                                } else {
                                    crate::logger::warn("Lyrics", &format!(
                                        "lyric fetch drop stale gen={} current_gen={}",
                                        gen,
                                        gen_ref.load(Ordering::Relaxed)
                                    ));
                                }
                            }).ok();
                        }
                    }

                    was_playing = true;

                    // 当 SMTC 不提供时长时，用最后一句歌词时间 +5s 做估算
                    let effective_duration_ms = if media_info.duration_ms > 0 {
                        media_info.duration_ms
                    } else if let Some(last) = current_lyrics.last() {
                        last.time_ms + 5000
                    } else {
                        0
                    };

                    if mode == "lyric" {
                        // 构建歌词文本和附近歌词（文本去重，但始终发送位置）
                        let (text_val, nearby_json, line_tokens, line_start_ms, next_line_time_ms) = if fetch_pending && current_lyrics.is_empty() {
                            // 正在获取歌词中
                            (serde_json::json!("♪"), None, None, None, None)
                        } else if lyrics_not_found || (!fetch_pending && current_lyrics.is_empty()) {
                            // 歌词未找到
                            (serde_json::json!(null), None, None, None, None)
                        } else if let Some(line_idx) = current_lyrics.iter().rposition(|l| l.time_ms <= position_ms) {
                            let line = &current_lyrics[line_idx];
                            // 仅在歌词行变化时计算附近歌词
                            let nearby = if line.text != last_lyric_text {
                                last_lyric_text = line.text.clone();
                                let nearby = lyrics::get_nearby_lyrics(&current_lyrics, position_ms);
                                Some(nearby.iter().map(|(text, is_current)| {
                                    serde_json::json!({"text": text, "is_current": is_current})
                                }).collect::<Vec<_>>())
                            } else {
                                None
                            };
                            let tokens = if line.tokens.is_empty() {
                                None
                            } else {
                                Some(line.tokens.clone())
                            };
                            let next_switch_ms = if line_idx + 1 < current_lyrics.len() {
                                current_lyrics[line_idx + 1].time_ms
                            } else {
                                line.end_time_ms
                            };
                            (serde_json::json!(line.text), nearby, tokens, Some(line.time_ms), Some(next_switch_ms))
                        } else {
                            let nearby = lyrics::get_nearby_lyrics(&current_lyrics, position_ms);
                            let nearby_json = Some(nearby.iter().map(|(text, is_current)| {
                                serde_json::json!({"text": text, "is_current": is_current})
                            }).collect::<Vec<_>>());
                            (serde_json::json!("♪"), nearby_json, None, None, None)
                        };

                        // 始终发送，确保进度条持续更新
                        let mut payload = serde_json::json!({
                            "text": text_val,
                            "title": media_info.title,
                            "artist": media_info.artist,
                            "genre": media_info.genre,
                            "position_ms": position_ms,
                            "duration_ms": effective_duration_ms,
                            "is_playing": is_playing,
                            "seekable": media_info.seekable
                        });
                        if let Some(nearby) = nearby_json {
                            payload["nearby_lyrics"] = serde_json::json!(nearby);
                        }
                        if let Some(tokens) = line_tokens {
                            payload["tokens"] = serde_json::json!(tokens);
                        }
                        if let Some(v) = line_start_ms {
                            payload["line_start_ms"] = serde_json::json!(v);
                        }
                        if let Some(v) = next_line_time_ms {
                            payload["next_line_time_ms"] = serde_json::json!(v);
                        }
                        let _ = win_media.emit("lyric-update", payload);
                    } else {
                        // info mode: 始终发送位置
                        let _ = win_media.emit("lyric-update", serde_json::json!({
                            "text": null,
                            "title": media_info.title,
                            "artist": media_info.artist,
                            "genre": media_info.genre,
                            "position_ms": position_ms,
                            "duration_ms": effective_duration_ms,
                            "is_playing": is_playing,
                            "seekable": media_info.seekable
                        }));
                    }
                }
            });

            if onboarding_completed.load(Ordering::Relaxed) {
                let _ = window.show();
            } else if let Err(error) = onboarding::open_onboarding(app.handle().clone()) {
                logger::error("Onboarding", &error);
                let _ = window.show();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[allow(dead_code)]
fn trigger_notification(
    window: &tauri::WebviewWindow,
    is_notifying: &Arc<AtomicBool>,
    is_expanded: &Arc<AtomicBool>,
    message: &str,
) {
    // 防重入：如果已有通知正在显示，跳过
    if is_notifying
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return;
    }

    if !is_expanded.load(Ordering::Relaxed) {
        is_expanded.store(true, Ordering::Relaxed);
        let _ = window.emit("set-expand", true);
    }
    let _ = window.emit("show-notice", message);

    // 在独立线程中等待超时，不阻塞调用者
    let noti = is_notifying.clone();
    let exp = is_expanded.clone();
    let win = window.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(3500));
        noti.store(false, Ordering::Relaxed);
        exp.store(false, Ordering::Relaxed);
        let _ = win.emit("set-expand", false);
        let _ = win.emit("notice-timeout", ());
    });
}

pub struct IslandState {
    pub onboarding_completed: Arc<AtomicBool>,
    pub is_notifying: Arc<AtomicBool>,
    pub is_expanded: Arc<AtomicBool>,
    pub is_dragging: Arc<AtomicBool>,
    pub is_interacting: Arc<AtomicBool>,
    pub is_pinned_expanded: Arc<AtomicBool>,
    pub suppress_auto_expand: Arc<AtomicBool>,
    pub lyric_mode: Arc<Mutex<String>>,
    pub lyric_offset_enabled: Arc<AtomicBool>,
    pub lyric_offsets_by_player: Arc<Mutex<std::collections::HashMap<String, i64>>>,
    pub active_player_app_id: Arc<Mutex<Option<String>>>,
    pub current_view: Arc<Mutex<String>>,
    pub music_expanded: Arc<AtomicBool>,
    pub is_minimized: Arc<AtomicBool>,
    pub expand_anim_id: Arc<AtomicU64>,
    pub screen_w: f64,
    pub indicator_color: Arc<Mutex<String>>,
    pub capsule_opacity: Arc<Mutex<f64>>,
    pub capsule_scale: Arc<Mutex<f64>>,
    pub icon_bar_style: Arc<Mutex<String>>,
    pub icon_bar_order: Arc<Mutex<Vec<String>>>,
    pub border_effect: Arc<Mutex<String>>,
    pub border_custom_source: Arc<Mutex<String>>,
    pub left_visual_mode: Arc<Mutex<String>>,
    pub left_visual_source: Arc<Mutex<String>>,
    pub right_visual_mode: Arc<Mutex<String>>,
    pub right_visual_source: Arc<Mutex<String>>,
    pub visual_assets: Arc<Mutex<Vec<settings::CustomAsset>>>,
    pub border_assets: Arc<Mutex<Vec<settings::CustomAsset>>>,
    pub rainbow_border: Arc<AtomicBool>,
    pub auto_start: Arc<AtomicBool>,
    pub blacklist_processes: Arc<Mutex<Vec<String>>>,
    pub blacklist_enabled: Arc<AtomicBool>,
    pub smtc_app_whitelist: Arc<Mutex<Vec<String>>>,
    pub smtc_whitelist_enabled: Arc<AtomicBool>,
    pub cc_routes: Arc<Mutex<Vec<cc::CcRoute>>>,
    pub obsidian_vault_path: Arc<Mutex<String>>,
    pub obsidian_daily_notes_dir: Arc<Mutex<String>>,
}
