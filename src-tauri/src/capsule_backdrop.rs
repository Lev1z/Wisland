//! A bounded composition visual, NOT a full-window DWM/Accent backdrop.
//! https://learn.microsoft.com/windows/apps/desktop/modernize/using-the-visual-layer-with-win32
use std::cell::RefCell;
use windows::{core::Interface, System::{DispatcherQueue, DispatcherQueueController}, UI::Composition::{Compositor, SpriteVisual, CompositionRoundedRectangleGeometry, Desktop::DesktopWindowTarget}, Win32::{Foundation::HWND, System::WinRT::{CreateDispatcherQueueController, DispatcherQueueOptions, DQTYPE_THREAD_CURRENT, DQTAT_COM_NONE, Composition::ICompositorDesktopInterop}}};
use windows_numerics::{Vector2, Vector3};

struct Backdrop {
    _queue: Option<DispatcherQueueController>,
    _compositor: Compositor,
    _target: DesktopWindowTarget,
    sprite: SpriteVisual,
    geometry: CompositionRoundedRectangleGeometry,
}
#[derive(Default)]
struct State {
    backdrop: Option<Backdrop>,
    bounds: Option<[f64; 5]>,
    enabled: bool,
}
// Composition objects and the queue are accessed only on their owning UI thread.
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

impl Backdrop {
    fn new(hwnd: HWND) -> windows::core::Result<Self> {
        let queue = if DispatcherQueue::GetForCurrentThread().is_err() {
            Some(unsafe { CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT, apartmentType: DQTAT_COM_NONE,
            })? })
        } else { None };
        let compositor = Compositor::new()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;
        let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };
        let sprite = compositor.CreateSpriteVisual()?;
        let geometry = compositor.CreateRoundedRectangleGeometry()?;
        sprite.SetClip(&compositor.CreateGeometricClipWithGeometry(&geometry)?)?;
        sprite.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
        sprite.SetIsVisible(false)?;
        target.SetRoot(&sprite)?;
        Ok(Self { _queue: queue, _compositor: compositor, _target: target, sprite, geometry })
    }
    fn update(&self, bounds: Option<[f64; 5]>, enabled: bool) -> windows::core::Result<()> {
        if let Some([x,y,width,height,radius]) = bounds {
            let size = Vector2 { X: width as f32, Y: height as f32 };
            self.sprite.SetOffset(Vector3 { X: x as f32, Y: y as f32, Z: 0.0 })?;
            self.sprite.SetSize(size)?;
            self.geometry.SetSize(size)?;
            self.geometry.SetCornerRadius(Vector2 { X: radius as f32, Y: radius as f32 })?;
            self.sprite.SetIsVisible(enabled)?;
        } else { self.sprite.SetIsVisible(false)?; }
        Ok(())
    }
}

pub fn set_bounds(bounds: Option<[f64; 5]>) -> Result<(), String> {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        state.bounds = bounds;
        if let Some(backdrop) = &state.backdrop { backdrop.update(bounds, state.enabled).map_err(|e| e.to_string())?; }
        Ok(())
    })
}
pub fn enable(hwnd: HWND, enabled: bool) -> Result<(), String> {
    STATE.with(|cell| {
        let mut state = cell.borrow_mut();
        if enabled && state.backdrop.is_none() { state.backdrop = Some(Backdrop::new(hwnd).map_err(|e| e.to_string())?); }
        state.enabled = enabled;
        if let Some(backdrop) = &state.backdrop { backdrop.update(state.bounds, enabled).map_err(|e| e.to_string())?; }
        Ok(())
    })
}
pub fn bounds() -> Option<[f64; 5]> {
    STATE.with(|cell| {
        let state = cell.borrow();
        let backdrop = state.backdrop.as_ref()?;
        let offset = backdrop.sprite.Offset().ok()?;
        let size = backdrop.sprite.Size().ok()?;
        let radius = backdrop.geometry.CornerRadius().ok()?;
        Some([offset.X as f64, offset.Y as f64, size.X as f64, size.Y as f64, radius.X as f64])
    })
}
