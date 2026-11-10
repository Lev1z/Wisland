//! Shared native material; sidebar clipping and motion remain managed separately.
use serde::Serialize;
use std::mem::{size_of, size_of_val};
use windows::core::BOOL;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
    Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
        DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
        DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DWM_BB_ENABLE, DWM_BB_BLURREGION, DWM_BLURBEHIND,
    },
    Graphics::Gdi::{CreateRectRgn, DeleteObject},
    System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
    UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        Controls::MARGINS,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            DefWindowProcW, FindWindowExW, GetForegroundWindow, GetWindowRect, SetWindowPos,
            SystemParametersInfoW, SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SWP_NOACTIVATE,
            SWP_NOZORDER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_NCACTIVATE, WM_NCDESTROY,
        },
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const MATERIAL_SUBCLASS: usize = 0x5749534c;

// DWM's material follows non-client activation, separately from keyboard focus.
// Keep only that visual state active. WM_ACTIVATE/WM_KILLFOCUS still reach Tao,
// so clicking another app really gives it focus and does not re-activate us.
unsafe extern "system" fn material_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _: usize,
) -> LRESULT {
    if message == WM_NCACTIVATE {
        return DefWindowProcW(hwnd, message, WPARAM(1), LPARAM(-1));
    }
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(material_proc), id);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

/// Install on the owning UI thread while the persistent sidebar is still hidden.
pub fn keep_material_active(panel: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = HWND(panel.hwnd().map_err(|e| e.to_string())?.0);
    unsafe {
        if !SetWindowSubclass(hwnd, Some(material_proc), MATERIAL_SUBCLASS, 0).as_bool() {
            return Err("无法固定侧栏背景材质".into());
        }
        DefWindowProcW(hwnd, WM_NCACTIVATE, WPARAM(1), LPARAM(-1));
    }
    Ok(())
}

pub fn cloak(panel: &tauri::WebviewWindow, hidden: bool) -> Result<(), String> {
    let hwnd = panel.hwnd().map_err(|e| e.to_string())?;
    let value = BOOL::from(hidden);
    unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd.0),
            windows::Win32::Graphics::Dwm::DWMWA_CLOAK,
            std::ptr::from_ref(&value).cast(),
            size_of::<BOOL>() as u32,
        )
    }
    .map_err(|e| e.to_string())
}

pub const OPEN_MS: u64 = 240;
pub const CLOSE_MS: u64 = 170;

/// Animate the live DWM surface, not an AnimateWindow snapshot of its non-client frame.
/// Position and clipping viewport change; decoration/material/opacity stay intact.
#[derive(Clone, Copy)]
pub struct Slide {
    pub y: i32,
    pub from_x: i32,
    pub to_x: i32,
    pub open: bool,
}

impl Slide {
    pub fn duration(&self) -> std::time::Duration {
        std::time::Duration::from_millis(if self.open { OPEN_MS } else { CLOSE_MS })
    }

    pub fn position(&self, progress: f64) -> tauri::PhysicalPosition<i32> {
        let t = progress.clamp(0.0, 1.0);
        let eased = if self.open {
            1.0 - (1.0 - t).powi(2)
        } else {
            t
        };
        tauri::PhysicalPosition::new(
            (self.from_x as f64 + (self.to_x - self.from_x) as f64 * eased).round() as i32,
            self.y,
        )
    }
}

fn visible_width(x: i32, boundary: i32, width: i32) -> i32 {
    (boundary - x).clamp(0, width)
}

pub fn minimum_viewport_width(panel: &tauri::WebviewWindow) -> Result<i32, String> {
    Ok((16.0 * panel.scale_factor().map_err(|e| e.to_string())?).ceil() as i32)
}

/// Resolve the actual bottom taskbar HWND; work areas may include auto-hidden or
/// customized taskbars. All coordinates are physical and monitor-specific.
pub fn taskbar_top(monitor: RECT, fallback: i32) -> i32 {
    let mut top = fallback;
    for class in [
        windows::core::w!("Shell_TrayWnd"),
        windows::core::w!("Shell_SecondaryTrayWnd"),
    ] {
        let mut after = None;
        while let Ok(hwnd) = unsafe { FindWindowExW(None, after, class, None) } {
            after = Some(hwnd);
            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut rect) }.is_ok()
                && rect.left < monitor.right
                && rect.right > monitor.left
                && rect.top >= monitor.top + (monitor.bottom - monitor.top) / 2
                && rect.top < monitor.bottom
                && rect.bottom >= monitor.bottom - 2
                && rect.right - rect.left > rect.bottom - rect.top
            {
                top = top.min(rect.top);
            }
        }
    }
    top
}

/// Use the native rectangular viewport as a right-edge clip. The full height is
/// already bounded above the taskbar. SetWindowRgn would break the DWM backdrop.
pub fn reveal(
    panel: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<i32>,
    boundary: i32,
    full_width: i32,
    opening: bool,
) -> Result<(), String> {
    let hwnd = panel.hwnd().map_err(|e| e.to_string())?;
    let height = panel.outer_size().map_err(|e| e.to_string())?.height as i32;
    let width = visible_width(position.x, boundary, full_width);
    // Tao's non-client margins can yield a negative client width for tiny HWNDs.
    // Keep that terminal sliver cloaked instead of asking WebView/softbuffer to
    // allocate an invalid surface. No pixels past the clip line are exposed.
    if width < minimum_viewport_width(panel)? {
        return cloak(panel, true);
    }
    let mut was_cloaked = 0u32;
    unsafe {
        windows::Win32::Graphics::Dwm::DwmGetWindowAttribute(
            HWND(hwnd.0),
            windows::Win32::Graphics::Dwm::DWMWA_CLOAKED,
            (&mut was_cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        )
    }
    .map_err(|e| e.to_string())?;
    unsafe {
        SetWindowPos(
            HWND(hwnd.0),
            None,
            position.x,
            position.y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
    }
    .map_err(|e| e.to_string())?;
    let mut actual = RECT::default();
    unsafe { GetWindowRect(HWND(hwnd.0), &mut actual) }.map_err(|e| e.to_string())?;
    if actual.right > boundary {
        return Err("侧栏动画视口越过屏幕右边界".into());
    }
    if was_cloaked != 0 && opening {
        cloak(panel, false)?;
        if opening {
            panel.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Called on a blocking worker, never on the UI thread. Avoid adding a fixed 16ms
/// sleep on top of window dispatch/composition time (which drops animation frames).
pub fn wait_for_composition() {
    if unsafe { DwmFlush() }.is_err() {
        std::thread::sleep(std::time::Duration::from_millis(8));
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub acrylic: bool,
    pub dark: bool,
    pub motion: bool,
}

fn allow_acrylic(transparency: bool, high_contrast: bool, battery_saver: bool) -> bool {
    transparency && !high_contrast && !battery_saver
}

pub fn is_foreground(panel: &tauri::WebviewWindow) -> bool {
    panel
        .hwnd()
        .is_ok_and(|handle| unsafe { GetForegroundWindow() == HWND(handle.0) })
}

pub fn apply(panel: &tauri::WebviewWindow, previous: Option<Appearance>, theme: &str) -> Appearance {
    let personalize = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .ok();
    let transparency = personalize
        .as_ref()
        .and_then(|key| key.get_value::<u32, _>("EnableTransparency").ok())
        .unwrap_or(1)
        != 0;
    let mut contrast = HIGHCONTRASTW {
        cbSize: size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let mut animations = BOOL(0);
    let mut power = SYSTEM_POWER_STATUS::default();
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            contrast.cbSize,
            Some((&mut contrast as *mut HIGHCONTRASTW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let _ = SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some((&mut animations as *mut BOOL).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        let _ = GetSystemPowerStatus(&mut power);
    }
    let high_contrast = contrast.dwFlags.contains(HCF_HIGHCONTRASTON);
    let dark = true; // All Wisland surfaces share the same dark theme palette.
    let requested = theme == "glass" && allow_acrylic(transparency, high_contrast, power.SystemStatusFlag == 1);
    let mut result = Appearance {
        acrylic: false,
        dark,
        motion: animations.as_bool() && !high_contrast,
    };
    // Reapplying an unchanged backdrop tears down its composition surface and can
    // expose a white frame. Keep the initialized surface across show/hide cycles.
    if let Some(previous) = previous {
        if previous.dark == dark && previous.acrylic == requested {
            return Appearance {
                motion: result.motion,
                ..previous
            };
        }
    }
    if let Ok(handle) = panel.hwnd() {
        let hwnd = HWND(handle.0);
        let dark = BOOL::from(dark);
        let backdrop = if requested {
            DWMSBT_TRANSIENTWINDOW
        } else {
            DWMSBT_NONE
        };
        unsafe {
            // Our position animation owns show/hide. Do not let DWM additionally
            // animate a cached standard-window frame during the visibility change.
            let disable_transitions = BOOL(1);
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                std::ptr::from_ref(&disable_transitions).cast(),
                size_of::<BOOL>() as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                (&dark as *const BOOL).cast(),
                size_of::<BOOL>() as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                std::ptr::from_ref(&DWMWCP_ROUND).cast(),
                size_of_val(&DWMWCP_ROUND) as u32,
            );
            // The documented Desktop Acrylic backdrop is supported from Windows 11 22621.
            // An unsupported DWM attribute leaves the opaque CSS fallback in place.
            result.acrylic = DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                std::ptr::from_ref(&backdrop).cast(),
                size_of_val(&backdrop) as u32,
            )
            .is_ok()
                && requested;
            if result.acrylic {
                // Tao's transparent-window setup enables legacy empty-region blur.
                // Replace that surface with a full DWM frame so Desktop Acrylic is
                // actually composited, rather than leaving clear desktop transparency.
                let _ = DwmEnableBlurBehindWindow(
                    hwnd,
                    &DWM_BLURBEHIND {
                        dwFlags: DWM_BB_ENABLE,
                        fEnable: BOOL(0),
                        ..Default::default()
                    },
                );
                let margins = MARGINS {
                    cxLeftWidth: -1,
                    cxRightWidth: -1,
                    cyTopHeight: -1,
                    cyBottomHeight: -1,
                };
                result.acrylic = DwmExtendFrameIntoClientArea(hwnd, &margins).is_ok();
            } else {
                // Remove the full-client glass frame when switching back to opaque.
                let _ = DwmExtendFrameIntoClientArea(hwnd, &MARGINS::default());
                // Restore Tao's transparent-window setup, otherwise the capsule's
                // click-through margins can become black after leaving acrylic.
                let region = CreateRectRgn(0, 0, -1, -1);
                let _ = DwmEnableBlurBehindWindow(hwnd, &DWM_BLURBEHIND {
                    dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
                    fEnable: BOOL(1), hRgnBlur: region, ..Default::default()
                });
                let _ = DeleteObject(region.into());
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inactive_material_messages_do_not_take_keyboard_focus() {
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SendMessageW, WINDOW_EX_STYLE, WS_POPUP,
        };
        unsafe {
            // A real, hidden native window on this test's owning thread.
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                windows::core::w!("STATIC"),
                windows::core::w!("Wisland material test"),
                WS_POPUP,
                0,
                0,
                30,
                30,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            assert!(SetWindowSubclass(hwnd, Some(material_proc), MATERIAL_SUBCLASS, 0).as_bool());
            let foreground = GetForegroundWindow();
            for active in [false, true, false] {
                let result = SendMessageW(
                    hwnd,
                    WM_NCACTIVATE,
                    Some(WPARAM(active as usize)),
                    Some(LPARAM(0)),
                );
                assert_ne!(result.0, 0, "material state must accept activation changes");
                assert_eq!(
                    GetForegroundWindow(),
                    foreground,
                    "visual activation must not steal focus"
                );
            }
            DestroyWindow(hwnd).unwrap(); // WM_NCDESTROY removes our subclass.
        }
    }
    #[test]
    fn clipping_never_crosses_screen_right_edge() {
        for boundary in [-100, 1040, 2080] {
            for height in [224, 304, 448, 608] {
                for y in (boundary - height - 8)..=(boundary + 16) {
                    let visible = visible_width(y, boundary, height);
                    assert!((0..=height).contains(&visible));
                    if visible > 0 {
                        assert!(y + visible <= boundary);
                    }
                }
                assert_eq!(visible_width(boundary, boundary, height), 0);
            }
        }
    }
    #[test]
    fn accessibility_and_power_settings_override_acrylic() {
        assert!(allow_acrylic(true, false, false));
        assert!(!allow_acrylic(false, false, false));
        assert!(!allow_acrylic(true, true, false));
        assert!(!allow_acrylic(true, false, true));
    }

    #[test]
    fn slides_left_to_open_and_right_to_close_without_overshooting() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let bottom = -200 + (304.0_f64 * scale).round() as i32;
            for open in [true, false] {
                let slide = Slide {
                    y: -400,
                    from_x: if open { bottom } else { -200 },
                    to_x: if open { -200 } else { bottom },
                    open,
                };
                assert_eq!(slide.position(-1.0).x, slide.from_x);
                assert_eq!(slide.position(2.0).x, slide.to_x);
                let mut previous = slide.from_x;
                for frame in 0..=100 {
                    let position = slide.position(frame as f64 / 100.0);
                    assert_eq!(position.y, -400);
                    assert!((-200..=bottom).contains(&position.x));
                    assert!(if open {
                        position.x <= previous
                    } else {
                        position.x >= previous
                    });
                    previous = position.x;
                }
            }
        }
    }

    #[test]
    fn reversing_a_slide_starts_at_its_current_position() {
        let opening = Slide {
            y: 20,
            from_x: 124,
            to_x: 100,
            open: true,
        };
        let closing = Slide {
            from_x: opening.position(0.3).x,
            to_x: 124,
            open: false,
            ..opening
        };
        assert_eq!(closing.position(0.0), opening.position(0.3));
        assert_eq!(closing.position(1.0).x, 124);
    }
}
