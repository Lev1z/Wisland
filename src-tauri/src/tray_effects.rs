//! Native effects are restricted to the transient Codex tray window.
use serde::Serialize;
use std::mem::{size_of, size_of_val};
use windows::core::BOOL;
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Dwm::{
        DwmEnableBlurBehindWindow, DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
        DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
        DWMWA_TRANSITIONS_FORCEDISABLED, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DWM_BB_ENABLE, DWM_BLURBEHIND,
    },
    System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
    UI::{
        Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
        Controls::MARGINS,
        WindowsAndMessaging::{
            FindWindowExW, GetForegroundWindow, GetWindowRect, SetWindowPos, SystemParametersInfoW,
            SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST, SWP_NOACTIVATE, SWP_NOZORDER,
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        },
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

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
/// Only position changes: decorations, shadow, glass margins and opacity stay intact.
#[derive(Clone, Copy)]
pub struct Slide {
    pub x: i32,
    pub from_y: i32,
    pub to_y: i32,
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
            self.x,
            (self.from_y as f64 + (self.to_y - self.from_y) as f64 * eased).round() as i32,
        )
    }
}

fn visible_height(y: i32, boundary: i32, height: i32) -> i32 {
    (boundary - y).clamp(0, height)
}

pub fn minimum_viewport_height(panel: &tauri::WebviewWindow) -> Result<i32, String> {
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

/// Use the native window's rectangular viewport as the clip. Its lower edge never
/// crosses the taskbar. Unlike SetWindowRgn this keeps the DWM backdrop intact.
pub fn reveal(
    panel: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<i32>,
    boundary: i32,
    full_height: i32,
    opening: bool,
) -> Result<(), String> {
    let hwnd = panel.hwnd().map_err(|e| e.to_string())?;
    let width = panel.outer_size().map_err(|e| e.to_string())?.width as i32;
    let height = visible_height(position.y, boundary, full_height);
    // Tao's non-client margins can yield a negative client height for tiny HWNDs.
    // Keep that terminal sliver cloaked instead of asking WebView/softbuffer to
    // allocate an invalid surface. No pixels below the clip line are exposed.
    if height < minimum_viewport_height(panel)? {
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
    if actual.bottom > boundary {
        return Err("托盘动画视口越过任务栏边界".into());
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

pub fn apply(panel: &tauri::WebviewWindow, previous: Option<Appearance>) -> Appearance {
    let personalize = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .ok();
    let transparency = personalize
        .as_ref()
        .and_then(|key| key.get_value::<u32, _>("EnableTransparency").ok())
        .unwrap_or(1)
        != 0;
    let dark = personalize
        .as_ref()
        .and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme").ok())
        .unwrap_or(1)
        == 0;
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
    let requested = allow_acrylic(transparency, high_contrast, power.SystemStatusFlag == 1);
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
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipping_never_crosses_taskbar_edge() {
        for boundary in [-100, 1040, 2080] {
            for height in [224, 304, 448, 608] {
                for y in (boundary - height - 8)..=(boundary + 16) {
                    let visible = visible_height(y, boundary, height);
                    assert!((0..=height).contains(&visible));
                    if visible > 0 {
                        assert!(y + visible <= boundary);
                    }
                }
                assert_eq!(visible_height(boundary, boundary, height), 0);
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
    fn slides_up_to_open_and_down_to_close_without_overshooting() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let bottom = -200 + (304.0_f64 * scale).round() as i32;
            for open in [true, false] {
                let slide = Slide {
                    x: -400,
                    from_y: if open { bottom } else { -200 },
                    to_y: if open { -200 } else { bottom },
                    open,
                };
                assert_eq!(slide.position(-1.0).y, slide.from_y);
                assert_eq!(slide.position(2.0).y, slide.to_y);
                let mut previous = slide.from_y;
                for frame in 0..=100 {
                    let position = slide.position(frame as f64 / 100.0);
                    assert_eq!(position.x, -400);
                    assert!((-200..=bottom).contains(&position.y));
                    assert!(if open {
                        position.y <= previous
                    } else {
                        position.y >= previous
                    });
                    previous = position.y;
                }
            }
        }
    }

    #[test]
    fn reversing_a_slide_starts_at_its_current_position() {
        let opening = Slide {
            x: 20,
            from_y: 124,
            to_y: 100,
            open: true,
        };
        let closing = Slide {
            from_y: opening.position(0.3).y,
            to_y: 124,
            open: false,
            ..opening
        };
        assert_eq!(closing.position(0.0), opening.position(0.3));
        assert_eq!(closing.position(1.0).y, 124);
    }
}
