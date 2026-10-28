//! Tray icon and menu. Everything is in the menu, since Linux tray clicks are unreliable.
//! The app stays fully usable without a tray (e.g. GNOME without the AppIndicator extension).

use crate::{engine::Phase, timer};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Wry,
};

pub struct TrayItems {
    pause: MenuItem<Wry>,
    stop: MenuItem<Wry>,
}

#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../icons/tray/tray-template@2x.png");
// Most Linux panels are dark; the light glyph reads best there.
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../icons/tray/tray-dark.png");

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Today", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Boss Timer", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &pause, &stop, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Boss Timer")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => timer::show_main(app),
            "pause" => timer::toggle_pause(app),
            "stop" => timer::stop_inner(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayItems { pause, stop });
    Ok(())
}

/// Keeps the Pause/Resume and Stop items in step with the timer.
pub fn update(app: &AppHandle, phase: Phase) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let live = matches!(phase, Phase::Running | Phase::Paused);
    let _ = items.pause.set_text(if phase == Phase::Paused { "Resume" } else { "Pause" });
    let _ = items.pause.set_enabled(live);
    let _ = items.stop.set_enabled(live);
}
