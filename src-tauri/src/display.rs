//! Live display geometry for the capsule; never retain startup screen dimensions.
use crate::{IslandState, TOP_MARGIN};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;

pub(crate) static LAYOUT_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn scale(hwnd: windows::Win32::Foundation::HWND) -> f64 {
    let dpi = unsafe { windows::Win32::UI::HiDpi::GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

fn anchor(origin: (i32, i32), monitor_width: u32, window_width: f64, dpi: f64) -> (f64, f64) {
    (
        origin.0 as f64 + (monitor_width as f64 - window_width) / 2.0,
        origin.1 as f64 + TOP_MARGIN * dpi,
    )
}

pub(crate) fn home(window: &tauri::WebviewWindow, logical_width: f64) -> (f64, f64) {
    let dpi = window.scale_factor().unwrap_or(1.0);
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let frame_width = window
            .outer_size()
            .ok()
            .zip(window.inner_size().ok())
            .map(|(outer, inner)| outer.width.saturating_sub(inner.width) as f64)
            .unwrap_or(0.0);
        let (x, y) = anchor(
            (monitor.position().x, monitor.position().y),
            monitor.size().width,
            logical_width * dpi + frame_width,
            dpi,
        );
        (x / dpi, y / dpi)
    } else {
        window
            .outer_position()
            .map(|p| (p.x as f64 / dpi, p.y as f64 / dpi))
            .unwrap_or((0.0, 0.0))
    }
}

type MonitorSignature = (String, i32, i32, u32, u32, u64, i32, i32, u32, u32);

fn signature(monitors: &[tauri::Monitor]) -> Vec<MonitorSignature> {
    let mut result: Vec<_> = monitors
        .iter()
        .map(|m| {
            (
                m.name().cloned().unwrap_or_default(),
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
                m.scale_factor().to_bits(),
                m.work_area().position.x,
                m.work_area().position.y,
                m.work_area().size.width,
                m.work_area().size.height,
            )
        })
        .collect();
    result.sort();
    result
}

pub(crate) fn watch(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        let mut previous = window
            .available_monitors()
            .map(|m| signature(&m))
            .unwrap_or_default();
        let mut preferred = window
            .current_monitor()
            .ok()
            .flatten()
            .and_then(|m| m.name().cloned());
        let mut pending = None;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let Ok(monitors) = window.available_monitors() else {
                continue;
            };
            if monitors.is_empty() {
                continue;
            }
            let current = signature(&monitors);
            if current != previous {
                previous = current;
                LAYOUT_EPOCH.fetch_add(1, Ordering::SeqCst);
                pending = Some(Instant::now());
            }
            if let Some(changed) = pending {
                // Let Windows finish its DPI/placement updates and old animations stop.
                if changed.elapsed() < Duration::from_millis(250) {
                    continue;
                }
                let target = preferred.clone();
                let panel = window.clone();
                let (sent, received) = std::sync::mpsc::channel();
                if window
                    .run_on_main_thread(move || {
                        crate::tray_mode::display_changed(panel.app_handle());
                        let state = panel.state::<IslandState>();
                        if state.is_dragging.load(Ordering::Relaxed)
                            || state.is_interacting.load(Ordering::Relaxed)
                        {
                            let _ = sent.send(false);
                            return;
                        }
                        let monitor = panel
                            .available_monitors()
                            .ok()
                            .and_then(|all| {
                                all.into_iter().find(|m| {
                                    target.as_ref().is_some_and(|name| m.name() == Some(name))
                                })
                            })
                            .or_else(|| panel.primary_monitor().ok().flatten());
                        let result = monitor
                            .and_then(|monitor| {
                                let size = panel.outer_size().ok()?;
                                let (x, y) = anchor(
                                    (monitor.position().x, monitor.position().y),
                                    monitor.size().width,
                                    size.width as f64,
                                    monitor.scale_factor(),
                                );
                                // Position only: retain expanded/music/minimized size, visibility and focus.
                                panel
                                    .set_position(tauri::PhysicalPosition::new(
                                        x.round() as i32,
                                        y.round() as i32,
                                    ))
                                    .ok()
                            })
                            .is_some();
                        let _ = sent.send(result);
                    })
                    .is_err()
                {
                    break;
                }
                if received
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap_or(false)
                {
                    pending = None;
                }
            } else {
                // A deliberate drag to another display becomes the new preferred monitor.
                preferred = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .and_then(|m| m.name().cloned());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolution_changes_recenter_in_physical_pixels() {
        assert_eq!(anchor((0, 0), 1920, 560.0, 1.0).0, 680.0);
        assert_eq!(anchor((0, 0), 2560, 560.0, 1.0).0, 1000.0);
        assert_eq!(anchor((0, 0), 1280, 560.0, 1.0).0, 360.0);
    }
    #[test]
    fn dpi_and_negative_monitor_origins_are_included() {
        assert_eq!(
            anchor((-2560, -300), 2560, 840.0, 1.5),
            (-1700.0, -300.0 + TOP_MARGIN * 1.5)
        );
        for dpi in [1.0, 1.25, 1.5, 2.0] {
            let (x, _) = anchor((1920, 0), 3840, 560.0 * dpi, dpi);
            assert_eq!(x + 280.0 * dpi, 3840.0);
        }
    }
}
