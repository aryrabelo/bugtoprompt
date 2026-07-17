//! macOS menu-bar tray shell for the BugToPrompt sidecar (issue #57).
//!
//! Wraps the embedded axum server (`sidecar_rust::serve`, issue #54) as a
//! background task supervised from a dedicated OS thread (see
//! `supervisor.rs`) so the `tao` event loop can own the main thread —
//! required for `tray-icon` on macOS. "Settings" is stubbed as a no-op menu
//! item until its window lands (#58, PRD §11 tech stack: Tauri webview).
//! Windows tray support is explicitly out of scope here (v2, PRD §12).

mod supervisor;

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tracing::info;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use sidecar_rust::config::Config;
use supervisor::Supervisor;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = Config::load();
    let port = config.port;

    if config.issue_mode && config.targets.is_empty() {
        eprintln!(
            "bugtoprompt: issue mode enabled but no repository is configured (set BUGTOPROMPT_REPOS or config.repos)."
        );
        std::process::exit(1);
    }

    // Start the embedded server on its own thread *before* the tao event
    // loop takes the main thread — tray-icon requires an already-running
    // event loop when the icon is created on macOS.
    let mut supervisor = Some(Supervisor::spawn(config));

    let status_item = MenuItem::new(
        format!("\u{1f41b} BugToPrompt \u{25cf} Running (port {port})"),
        false,
        None,
    );
    let settings_item = MenuItem::new("Settings", true, None);
    let logs_item = MenuItem::new("Open logs", true, None);
    let quit_item = MenuItem::new("Quit", true, None);

    let tray_menu = Menu::with_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &settings_item,
        &logs_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ])
    .expect("failed to build tray menu");

    let menu_channel = MenuEvent::receiver();

    let mut event_loop = EventLoop::new();
    // Menu-bar-only app: no Dock icon, no app switcher entry.
    event_loop.set_activation_policy(ActivationPolicy::Accessory);

    let mut tray_icon: Option<TrayIcon> = None;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        if let Event::NewEvents(StartCause::Init) = event
            && tray_icon.is_none()
        {
            tray_icon = Some(
                TrayIconBuilder::new()
                    .with_menu(Box::new(tray_menu.clone()))
                    .with_tooltip(format!("BugToPrompt \u{2014} running on port {port}"))
                    .with_icon(bug_icon())
                    .with_icon_as_template(true)
                    .build()
                    .expect("failed to build tray icon"),
            );
        }

        if let Ok(menu_event) = menu_channel.try_recv() {
            if menu_event.id() == quit_item.id() {
                info!("Quit clicked, shutting down sidecar server");
                if let Some(mut sup) = supervisor.take() {
                    sup.shutdown();
                }
                tray_icon = None;
                *control_flow = ControlFlow::Exit;
            } else if menu_event.id() == settings_item.id() {
                // ponytail: settings window lands with #58; no-op placeholder for now.
                info!("Settings clicked, settings window not implemented yet (#58)");
            } else if menu_event.id() == logs_item.id() {
                open_logs_dir();
            }
        }
    });
}

/// Minimal 16x16 monochrome bug-shaped glyph, generated at build time so the
/// crate ships with zero binary asset files.
///
/// ponytail: real app icon lands with packaging (#59); this is a template
/// (alpha-only) dot so it renders correctly in light/dark menu bars.
fn bug_icon() -> Icon {
    const SIZE: u32 = 16;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    let center = SIZE as i32 / 2;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as i32 - center;
            let dy = y as i32 - center;
            let inside = dx * dx + dy * dy <= 36;
            let idx = ((y * SIZE + x) * 4) as usize;
            rgba[idx + 3] = if inside { 255 } else { 0 }; // alpha only — RGB stays 0 for a template icon.
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).expect("static bug icon must be valid RGBA")
}

/// Opens (creating if needed) `~/Library/Logs/BugToPrompt` in Finder.
///
/// ponytail: no log *file* writer exists yet — `tracing` still writes to
/// stdout only (see `main`'s `tracing_subscriber::fmt()`), so this opens an
/// initially-empty placeholder directory. Wiring a rolling file appender is
/// out of scope for #57; add when a real log file exists to show.
fn open_logs_dir() {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let dir = std::path::PathBuf::from(home)
        .join("Library")
        .join("Logs")
        .join("BugToPrompt");
    if let Err(err) = std::fs::create_dir_all(&dir) {
        tracing::warn!("failed to create logs dir {}: {err}", dir.display());
        return;
    }
    if let Err(err) = std::process::Command::new("open").arg(&dir).spawn() {
        tracing::warn!("failed to open logs dir {}: {err}", dir.display());
    }
}
