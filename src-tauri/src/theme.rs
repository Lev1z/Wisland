use crate::{tray_effects, IslandState};
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;
use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};

#[derive(Default)]
pub struct ThemeState {
    materials: Mutex<HashMap<String, tray_effects::Appearance>>,
}

pub(crate) fn forget_window(app: &tauri::AppHandle, label: &str) {
    app.state::<ThemeState>().materials.lock().unwrap().remove(label);
}

pub(crate) fn sync_window(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> tray_effects::Appearance {
    if window.label() == "codex-tray" {
        return crate::tray_mode::sync_appearance(app, window);
    }
    let theme = app.state::<IslandState>().border_effect.lock().unwrap().clone();
    let state = app.state::<ThemeState>();
    let mut cache = state.materials.lock().unwrap();
    let _ = tray_effects::keep_material_active(window);
    let appearance = tray_effects::apply(window, cache.get(window.label()).copied(), &theme);
    cache.insert(window.label().into(), appearance);
    appearance
}

#[tauri::command]
pub fn get_window_theme(app: tauri::AppHandle, window: tauri::WebviewWindow) -> tray_effects::Appearance {
    sync_window(&app, &window)
}

// The capsule's native window includes click-through margins. Clip the material
// to its current CSS outline instead of tinting those transparent margins.
#[tauri::command]
pub fn sync_capsule_theme_clip(window: tauri::WebviewWindow, bounds: Option<[f64; 5]>) -> Result<(), String> {
    if window.label() != "main" { return Err("仅胶囊窗口可更新轮廓".into()); }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        if let Some([x, y, width, height, radius]) = bounds {
            if ![x,y,width,height,radius].iter().all(|n| n.is_finite()) || width <= 0.0 || height <= 0.0 {
                return Err("无效的胶囊轮廓".into());
            }
            let dpi = window.scale_factor().map_err(|e| e.to_string())?;
            let region = CreateRoundRectRgn((x*dpi).floor() as i32, (y*dpi).floor() as i32,
                ((x+width)*dpi).ceil() as i32 + 1, ((y+height)*dpi).ceil() as i32 + 1,
                (radius*2.0*dpi).round() as i32, (radius*2.0*dpi).round() as i32);
            if region.0.is_null() { return Err("无法创建胶囊轮廓".into()); }
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(region.into());
                return Err("无法应用胶囊轮廓".into());
            }
            // Windows owns the region after a successful SetWindowRgn.
        } else if SetWindowRgn(hwnd, None, true) == 0 {
            return Err("无法恢复胶囊轮廓".into());
        }
    }
    Ok(())
}
