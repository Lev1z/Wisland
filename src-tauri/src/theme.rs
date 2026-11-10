use crate::{tray_effects, IslandState};
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;
use windows::Win32::Graphics::Gdi::{DeleteObject, SetWindowRgn};

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
    let theme = app.state::<IslandState>().theme.lock().unwrap().clone();
    let state = app.state::<ThemeState>();
    let mut cache = state.materials.lock().unwrap();
    if window.label() != "main" { let _ = tray_effects::keep_material_active(window); }
    let appearance = tray_effects::apply(window, cache.get(window.label()).copied(), &theme);
    cache.insert(window.label().into(), appearance);
    appearance
}

// Clear all old full-host effects, then enable only the bounded composition
// visual behind WebView2. A GDI window region does NOT clip Accent's DWM surface.
// The sidebar keeps its existing Desktop Acrylic implementation and animation.
pub(crate) fn apply_capsule_material(window: &tauri::WebviewWindow, requested: bool, previous: Option<tray_effects::Appearance>) -> bool {
    use std::mem::size_of;
    use windows::{core::{w, s, BOOL}, Win32::{Foundation::COLORREF, Graphics::{Dwm::*, Gdi::CreateRectRgn}, System::LibraryLoader::{GetModuleHandleW, GetProcAddress}, UI::Controls::MARGINS}};
    if previous.is_some_and(|p| p.acrylic == requested) { return requested; }
    let Ok(hwnd) = window.hwnd() else { return false; };
    unsafe {
        let none = DWMSBT_NONE;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, std::ptr::from_ref(&none).cast(), size_of_val(&none) as u32);
        let _ = DwmExtendFrameIntoClientArea(hwnd, &MARGINS::default());
        let corners = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, std::ptr::from_ref(&corners).cast(), size_of_val(&corners) as u32);
        let border = COLORREF(0xfffffffe); // DWMWA_COLOR_NONE: no rectangular native outline.
        let _ = DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, std::ptr::from_ref(&border).cast(), size_of::<COLORREF>() as u32);
        // Preserve Tao's transparent WebView host after removing a full DWM frame.
        let region = CreateRectRgn(0, 0, -1, -1);
        let _ = DwmEnableBlurBehindWindow(hwnd, &DWM_BLURBEHIND {
            dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION, fEnable: BOOL(1), hRgnBlur: region, ..Default::default()
        });
        let _ = DeleteObject(region.into());
        #[repr(C)] struct Accent { state: i32, flags: u32, color: u32, animation: u32 }
        #[repr(C)] struct Data { attribute: i32, data: *const Accent, size: usize }
        type SetComposition = unsafe extern "system" fn(windows::Win32::Foundation::HWND, *const Data) -> BOOL;
        let Ok(module) = GetModuleHandleW(w!("user32.dll")) else { return false; };
        let Some(proc) = GetProcAddress(module, s!("SetWindowCompositionAttribute")) else { return false; };
        // Same accent ABI used by window-vibrancy's Windows 10 acrylic path.
        let set: SetComposition = std::mem::transmute(proc);
        let accent = Accent { state: 0, flags: 0, color: 0, animation: 0 };
        let data = Data { attribute: 19, data: &accent, size: size_of::<Accent>() };
        let _ = set(hwnd, &data); // Remove the old full-host accent surface.
        let enabled = BOOL::from(requested);
        if DwmSetWindowAttribute(hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, std::ptr::from_ref(&enabled).cast(), size_of::<BOOL>() as u32).is_err() {
            return false;
        }
        let _ = SetWindowRgn(hwnd, None, true);
        match crate::capsule_backdrop::enable(hwnd, requested) {
            Ok(()) => requested,
            Err(error) => { crate::logger::warn("Theme", &format!("胶囊局部毛玻璃不可用：{error}")); false }
        }
    }
}

#[tauri::command]
pub fn get_window_theme(app: tauri::AppHandle, window: tauri::WebviewWindow) -> serde_json::Value {
    let appearance = sync_window(&app, &window);
    let clip = if window.label() == "main" { crate::capsule_backdrop::bounds().map(|[x,y,w,h,_]| [x,y,x+w,y+h]) } else { None };
    let mut value = serde_json::json!({"acrylic":appearance.acrylic,"dark":appearance.dark,"motion":appearance.motion,"capsuleClip":clip});
    if window.label() == "main" {
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_BORDER_COLOR};
        if let Ok(hwnd) = window.hwnd() {
            for (name, attribute) in [("hostBackdrop", DWMWA_SYSTEMBACKDROP_TYPE), ("hostBorder", DWMWA_BORDER_COLOR)] {
                let mut result = 0u32;
                if unsafe { DwmGetWindowAttribute(hwnd, attribute, (&mut result as *mut u32).cast(), 4) }.is_ok() {
                    value[name] = result.into();
                }
            }
        }
    }
    value
}

// The capsule's native window includes click-through margins. Clip the material
// to its current CSS outline instead of tinting those transparent margins.
#[tauri::command]
pub fn sync_capsule_theme_clip(window: tauri::WebviewWindow, bounds: Option<[f64; 5]>) -> Result<(), String> {
    if window.label() != "main" { return Err("仅胶囊窗口可更新轮廓".into()); }
    let bounds = if let Some(bounds) = bounds {
        if !bounds.iter().all(|n| n.is_finite()) || bounds[2] <= 0.0 || bounds[3] <= 0.0 {
            return Err("无效的胶囊轮廓".into());
        }
        let dpi = window.scale_factor().map_err(|e| e.to_string())?;
        Some(bounds.map(|n| n * dpi))
    } else { None };
    crate::capsule_backdrop::set_bounds(bounds)
}
