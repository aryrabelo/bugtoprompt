//! macOS menu-bar tray shell for the BugToPrompt sidecar (issue #57).
//!
//! Wraps the embedded axum server (`sidecar_rust::serve`, issue #54) as a
//! background task supervised from a dedicated OS thread (see
//! `supervisor.rs`) so the `tao` event loop can own the main thread —
//! required for `tray-icon` on macOS. Windows tray support is out of scope
//! here (v2, PRD §12).
//!
//! Clicking "Settings" now opens a `wry` (Tauri) webview (`settings_window`)
//! that edits `config.toml` (#58, PRD §8). On first run the tray imports an
//! existing LaunchAgent plist's env into `config.toml` (PRD §14 note 4).

mod settings_ui;
mod settings_window;
mod supervisor;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopProxy};
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
use tracing::info;
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use settings_ui::Ipc;
use settings_window::{SettingsWindow, Worker};
use sidecar_rust::config::{self, Config};
use sidecar_rust::updater::{self, ReleaseInfo};
use supervisor::Supervisor;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // One-time: import an existing LaunchAgent plist's env into config.toml
    // before the config is loaded (PRD §14 note 4). No-op once config exists.
    sidecar_rust::migrate::run_first_run_migration();

    // Retire the legacy Node LaunchAgent (issue #59): stop the old daemon and
    // rename its plist so exactly one process binds port 4127 and launchd never
    // reloads it at the next login. Runs before we bind the port; best effort.
    sidecar_rust::launch::disable_legacy_launch_agent();

    let config = Config::load();
    let mut running_port = config.port;
    let mut running_host = config.host.clone();

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

    // Auto-launch on login (issue #59), replacing the retired LaunchAgent. Uses
    // the `auto-launch` crate (the library the Tauri autostart plugin wraps)
    // with the macOS Login Items backend — the modern, user-visible mechanism
    // in System Settings, not a hand-written plist. Registered once on first run.
    let auto_launch = build_auto_launch();
    ensure_first_run_autostart(auto_launch.as_ref());
    let start_at_login_checked = auto_launch
        .as_ref()
        .and_then(|al| al.is_enabled().ok())
        .unwrap_or(false);

    let status_item = MenuItem::new(
        format!("\u{1f41b} BugToPrompt \u{25cf} Running (port {running_port})"),
        false,
        None,
    );
    let settings_item = MenuItem::new("Settings", true, None);
    let logs_item = MenuItem::new("Open logs", true, None);
    let quit_item = MenuItem::new("Quit", true, None);
    let start_at_login_item =
        CheckMenuItem::new("Start at Login", true, start_at_login_checked, None);
    let update_item = MenuItem::new("Check for updates\u{2026}", true, None);

    let tray_menu = Menu::with_items(&[
        &status_item,
        &PredefinedMenuItem::separator(),
        &settings_item,
        &logs_item,
        &start_at_login_item,
        &update_item,
        &PredefinedMenuItem::separator(),
        &quit_item,
    ])
    .expect("failed to build tray menu");

    let menu_channel = MenuEvent::receiver();

    let mut event_loop = EventLoop::new();
    // Menu-bar-only app: no Dock icon, no app switcher entry.
    event_loop.set_activation_policy(ActivationPolicy::Accessory);

    // Wake handle so the background update-check thread can nudge the parked
    // event loop the instant it has a result (PRD §10 auto-update).
    let update_proxy = event_loop.create_proxy();

    let mut tray_icon: Option<TrayIcon> = None;

    // Settings-window plumbing (#58). The webview forwards IPC messages over
    // `ipc_*`; background probe/install workers report over `worker_*`.
    let (ipc_tx, ipc_rx) = mpsc::channel::<String>();
    let (worker_tx, worker_rx) = mpsc::channel::<Worker>();
    let mut settings: Option<SettingsWindow> = None;
    let mut uvx_status = String::from("checking");

    // Kick off a background GitHub-release check at startup. Its result arrives
    // over `worker_*` and refreshes the "Check for updates" menu item.
    spawn_update_check(worker_tx.clone(), update_proxy.clone());
    let mut update_url: Option<String> = None;

    event_loop.run(move |event, target, control_flow| {
        // Poll the IPC/worker channels while the settings window is open;
        // otherwise sleep until the next OS/menu event.
        *control_flow = if settings.is_some() {
            ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(120))
        } else {
            ControlFlow::Wait
        };

        match event {
            Event::NewEvents(StartCause::Init) if tray_icon.is_none() => {
                tray_icon = Some(
                    TrayIconBuilder::new()
                        .with_menu(Box::new(tray_menu.clone()))
                        .with_tooltip(format!(
                            "BugToPrompt \u{2014} running on port {running_port}"
                        ))
                        .with_icon(bug_icon())
                        .with_icon_as_template(true)
                        .build()
                        .expect("failed to build tray icon"),
                );
            }
            // Closing the settings window drops its webview/window.
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                settings = None;
            }
            _ => {}
        }

        if let Ok(menu_event) = menu_channel.try_recv() {
            if menu_event.id() == quit_item.id() {
                info!("Quit clicked, shutting down sidecar server");
                if let Some(mut sup) = supervisor.take() {
                    sup.shutdown();
                }
                settings = None;
                tray_icon = None;
                *control_flow = ControlFlow::Exit;
            } else if menu_event.id() == settings_item.id() {
                if settings.is_none() {
                    match SettingsWindow::open(target, ipc_tx.clone()) {
                        Ok(win) => settings = Some(win),
                        Err(err) => tracing::error!("failed to open settings window: {err}"),
                    }
                }
            } else if menu_event.id() == logs_item.id() {
                open_logs_dir();
            } else if menu_event.id() == start_at_login_item.id() {
                toggle_autostart(&start_at_login_item, auto_launch.as_ref());
            } else if menu_event.id() == update_item.id() {
                handle_update_click(&update_item, &update_url, &worker_tx, &update_proxy);
            }
        }

        // Messages from the settings webview.
        while let Ok(raw) = ipc_rx.try_recv() {
            let Some(msg) = settings_ui::parse_ipc(&raw) else {
                continue;
            };
            match msg {
                Ipc::Ready => {
                    if let Some(win) = &settings {
                        win.push_state(&settings_ui::state_json(
                            &config::load_persisted(),
                            supervisor.is_some(),
                            &running_host,
                            running_port,
                            &uvx_status,
                        ));
                    }
                    settings_window::spawn_uvx_probe(worker_tx.clone());
                }
                Ipc::ProbeUvx => settings_window::spawn_uvx_probe(worker_tx.clone()),
                Ipc::InstallUvx => settings_window::spawn_uvx_install(worker_tx.clone()),
                Ipc::Save { config: payload } => {
                    let saved = save_and_restart(
                        payload,
                        &mut supervisor,
                        &mut running_host,
                        &mut running_port,
                    );
                    if let Some(win) = &settings {
                        win.push_saved(saved);
                        if saved {
                            win.push_state(&settings_ui::state_json(
                                &config::load_persisted(),
                                supervisor.is_some(),
                                &running_host,
                                running_port,
                                &uvx_status,
                            ));
                        }
                    }
                }
                Ipc::Quit => {
                    info!("Quit requested from settings, shutting down");
                    if let Some(mut sup) = supervisor.take() {
                        sup.shutdown();
                    }
                    settings = None;
                    tray_icon = None;
                    *control_flow = ControlFlow::Exit;
                }
            }
        }

        // Results from background probe/install workers.
        while let Ok(msg) = worker_rx.try_recv() {
            match msg {
                Worker::Uvx(ready) => {
                    uvx_status = if ready { "ready" } else { "missing" }.to_string();
                    if let Some(win) = &settings {
                        win.push_uvx(&uvx_status);
                    }
                }
                Worker::InstallLine(line) => {
                    if let Some(win) = &settings {
                        win.push_install_line(&line);
                    }
                }
                Worker::Update(available) => {
                    apply_update_result(&update_item, &mut update_url, available);
                }
            }
        }
    });
}

/// Validate, persist, then restart the server so it picks up the new CORS
/// allowlist / host / port / transcription preference. Restart-on-save is
/// acceptable for v1 per the #58 acceptance criteria; hot-reload is a
/// nice-to-have. Returns whether the config was written.
///
/// The effective config is validated BEFORE anything is written or the
/// supervisor is replaced (finding #10): saving issue mode with zero repos
/// would restart an immediately-invalid sidecar, so that save is rejected.
fn save_and_restart(
    payload: settings_ui::SavePayload,
    supervisor: &mut Option<Supervisor>,
    running_host: &mut String,
    running_port: &mut u16,
) -> bool {
    let Some(path) = config::config_path() else {
        tracing::warn!("no config path (HOME unset); cannot save settings");
        return false;
    };
    let next = settings_ui::apply_save(config::load_persisted(), payload);

    // Build the effective config and validate it before touching disk.
    let effective = Config::from_persisted(next.clone());
    if effective.issue_mode && effective.targets.is_empty() {
        tracing::warn!("refusing to save: issue mode enabled but no repository configured");
        return false;
    }

    if let Err(err) = next.save(&path) {
        tracing::error!("failed to write {}: {err}", path.display());
        return false;
    }
    if let Some(mut sup) = supervisor.take() {
        sup.shutdown();
    }
    *running_host = effective.host.clone();
    *running_port = effective.port;
    *supervisor = Some(Supervisor::spawn(effective));
    info!(
        "settings saved; server restarted on {}:{}",
        running_host, running_port
    );
    true
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

/// GitHub `owner/repo` the updater polls for new releases (issue #59, PRD §10).
const UPDATE_REPO: &str = "aryrabelo/bugtoprompt";

/// Build the login-item auto-launcher for the currently-running executable.
/// `None` (logged) when the exe path or the platform registration is
/// unavailable, so auto-launch simply degrades to off rather than crashing.
fn build_auto_launch() -> Option<auto_launch::AutoLaunch> {
    let exe = std::env::current_exe()
        .inspect_err(|err| tracing::warn!("auto-launch: cannot resolve current exe: {err}"))
        .ok()?;
    auto_launch::AutoLaunchBuilder::new()
        .set_app_name("BugToPrompt")
        .set_app_path(&exe.to_string_lossy())
        .build()
        .inspect_err(|err| tracing::warn!("auto-launch: builder failed: {err}"))
        .ok()
}

/// The one-time marker guarding first-run auto-launch registration, alongside
/// `config.toml` in `~/.config/bugtoprompt/`.
fn autostart_marker_path() -> Option<std::path::PathBuf> {
    let config = sidecar_rust::config::config_path()?;
    config
        .parent()
        .map(|dir| dir.join(".autostart-initialized"))
}

/// Register auto-launch on the very first run so the app "just works" after a
/// drag-install, then never force it again (the user owns the toggle after).
fn ensure_first_run_autostart(al: Option<&auto_launch::AutoLaunch>) {
    let Some(al) = al else {
        return;
    };
    let Some(marker) = autostart_marker_path() else {
        return;
    };
    if marker.exists() {
        return;
    }
    match al.enable() {
        Ok(()) => {
            if let Some(parent) = marker.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(err) = std::fs::write(&marker, "1") {
                tracing::warn!("auto-launch: could not write first-run marker: {err}");
            }
            tracing::info!("auto-launch: registered at login (first run)");
        }
        Err(err) => tracing::warn!("auto-launch: first-run enable failed: {err}"),
    }
}

/// Sync the real login-item state to a just-toggled "Start at Login" checkbox,
/// reverting the checkmark to reality if the OS registration call fails.
fn toggle_autostart(item: &CheckMenuItem, al: Option<&auto_launch::AutoLaunch>) {
    let Some(al) = al else {
        return;
    };
    let want = item.is_checked();
    let result = if want { al.enable() } else { al.disable() };
    if let Err(err) = result {
        tracing::warn!("auto-launch: toggle to {want} failed: {err}");
        item.set_checked(al.is_enabled().unwrap_or(!want));
    }
}

/// Run the GitHub-release check off the main thread, report the result over
/// `tx`, and wake the event loop so the tray reflects it immediately.
fn spawn_update_check(tx: mpsc::Sender<Worker>, proxy: EventLoopProxy<()>) {
    std::thread::spawn(move || {
        let available = updater::check_for_update(UPDATE_REPO, env!("CARGO_PKG_VERSION"));
        let _ = tx.send(Worker::Update(available));
        let _ = proxy.send_event(());
    });
}

/// Handle a click on the update menu item: open the release page when an update
/// is pending, otherwise trigger a fresh check.
fn handle_update_click(
    item: &MenuItem,
    url: &Option<String>,
    tx: &mpsc::Sender<Worker>,
    proxy: &EventLoopProxy<()>,
) {
    if let Some(url) = url {
        if let Err(err) = std::process::Command::new("open").arg(url).spawn() {
            tracing::warn!("failed to open release page {url}: {err}");
        }
        return;
    }
    item.set_text("Checking for updates\u{2026}");
    spawn_update_check(tx.clone(), proxy.clone());
}

/// Apply an update-check result to the tray: advertise a newer release (storing
/// its page URL for the next click) or report that the app is current.
fn apply_update_result(item: &MenuItem, url: &mut Option<String>, available: Option<ReleaseInfo>) {
    match available {
        Some(release) => {
            item.set_text(format!("Update available: {} \u{2192}", release.tag));
            *url = Some(release.html_url);
        }
        None => item.set_text("Up to date"),
    }
}
