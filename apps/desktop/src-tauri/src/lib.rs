//! The desktop shell: the web app (the server's origin, see settings.rs) in a
//! window of its own, plus what a browser tab cannot do: a tray icon, OS
//! notifications from the server's feed, start at login, single instance,
//! remembered window size and position, and signed updates.
//!
//! Two kinds of window, and the line between them is the security boundary:
//!
//!   "main"   the REMOTE web app. No IPC: no capability names it, and Tauri
//!            ACL-checks every call from a remote origin. Locked to the
//!            server's origin by policy.rs.
//!   "setup"  the LOCAL page in ui/ (server address, offline screen, toggles).
//!            The only window capabilities/setup.json lets call the commands
//!            below, and only from the bundled origin.
//!
//! Closing the app window hides it: the tray keeps the app, and its
//! notifications, running. `--hidden` (what start at login passes) starts in
//! the tray.

mod feed;
mod policy;
mod settings;

use serde::Serialize;
use settings::Settings;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const MAIN: &str = "main";
const SETUP: &str = "setup";
const TRAY: &str = "tray";
const HIDDEN_ARG: &str = "--hidden";
/// While the server is unreachable, how often the shell tries again by itself.
const OFFLINE_RETRY: Duration = Duration::from_secs(30);
const UPDATE_EVERY: Duration = Duration::from_secs(12 * 3600);

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Checking,
    Online,
    Offline { message: String },
}

pub struct Shell {
    settings: Mutex<Settings>,
    path: PathBuf,
    /// Bumped on every (re)connect; a feed thread or retry loop from an older
    /// connect sees it moved and exits.
    generation: Arc<AtomicU64>,
    status: Mutex<Status>,
    /// The origin the open app window was built for (its navigation policy).
    main_server: Mutex<Option<Url>>,
    updater: bool,
    update: Mutex<Option<tauri_plugin_updater::Update>>,
}

impl Shell {
    fn new(path: PathBuf, updater: bool) -> Self {
        Shell {
            settings: Mutex::new(Settings::load(&path)),
            path,
            generation: Arc::new(AtomicU64::new(0)),
            status: Mutex::new(Status::Checking),
            main_server: Mutex::new(None),
            updater,
            update: Mutex::new(None),
        }
    }
}

fn shell<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

fn product<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().name.clone()
}

// ---- connecting -------------------------------------------------------------

/// Is the app there? `GET <server>/api/health` (apps/web), 2xx = yes.
fn probe(server: &Url) -> Result<(), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(6)))
        .http_status_as_error(false)
        .build()
        .into();
    let host = server.host_str().unwrap_or("the server");
    let url = server.join("/api/health").map_err(|e| e.to_string())?;
    match agent.get(url.as_str()).call() {
        Ok(r) if r.status().is_success() => Ok(()),
        Ok(r) if r.status().as_u16() == 404 => Err(format!(
            "{host} answered, but it does not look like this app (no /api/health)."
        )),
        Ok(r) => Err(format!(
            "{host} is up but not healthy (HTTP {}). Try again in a minute.",
            r.status().as_u16()
        )),
        Err(e) => Err(format!("Can't reach {host}: {e}")),
    }
}

/// (Re)connect to the configured server. Blocking (it probes the server):
/// never call it on the main thread. `show` = the user is waiting for it.
fn connect<R: Runtime>(app: &AppHandle<R>, show: bool) -> Status {
    let st = shell(app);
    let gen = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *st.status.lock().unwrap() = Status::Checking;
    let server = st.settings.lock().unwrap().server();

    let status = match probe(&server) {
        Ok(()) => Status::Online,
        Err(message) => Status::Offline { message },
    };
    if st.generation.load(Ordering::SeqCst) != gen {
        return status; // a newer connect took over while we probed
    }
    *st.status.lock().unwrap() = status.clone();

    match &status {
        Status::Online => {
            open_main(app, &server, show);
            if show {
                if let Some(w) = app.get_webview_window(SETUP) {
                    let _ = w.close();
                }
            }
            follow_feed(app.clone(), server, gen);
        }
        Status::Offline { message } => {
            eprintln!("[desktop] offline: {message}");
            if show {
                open_setup(app);
            }
            retry_later(app.clone(), gen);
        }
        Status::Checking => {}
    }
    refresh_tray(app);
    status
}

/// While offline, try again now and then, until a newer connect takes over.
fn retry_later<R: Runtime>(app: AppHandle<R>, gen: u64) {
    std::thread::spawn(move || {
        if sleep_while_current(&app, gen, OFFLINE_RETRY) {
            let visible = app
                .get_webview_window(MAIN)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            connect(&app, visible);
        }
    });
}

/// Sleep up to `d` in short steps; false as soon as `gen` is superseded.
fn sleep_while_current<R: Runtime>(app: &AppHandle<R>, gen: u64, d: Duration) -> bool {
    let step = Duration::from_millis(500);
    let mut left = d;
    while !left.is_zero() {
        if shell(app).generation.load(Ordering::SeqCst) != gen {
            return false;
        }
        let s = step.min(left);
        std::thread::sleep(s);
        left -= s;
    }
    shell(app).generation.load(Ordering::SeqCst) == gen
}

/// The app window for `server`: reused if it already shows that origin, else
/// (re)built with a navigation policy bound to it.
fn open_main<R: Runtime>(app: &AppHandle<R>, server: &Url, show: bool) {
    let st = shell(app);
    let existing = app.get_webview_window(MAIN);
    let same = st.main_server.lock().unwrap().as_ref() == Some(server);
    if let (Some(w), true) = (&existing, same) {
        if show {
            reveal(w);
        }
        return;
    }
    if let Some(w) = existing {
        let _ = w.destroy();
    }

    let (nav_app, nav_server) = (app.clone(), server.clone());
    let (win_app, win_server) = (app.clone(), server.clone());
    let built = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(server.clone()))
        .title(product(app))
        .inner_size(1280.0, 860.0)
        .min_inner_size(400.0, 320.0)
        .visible(show)
        .on_navigation(move |url| match policy::decide(url, &nav_server) {
            policy::Nav::Stay => true,
            policy::Nav::Browser => {
                open_external(&nav_app, url);
                false
            }
            policy::Nav::Block => {
                eprintln!("[desktop] blocked navigation to {}", url.scheme());
                false
            }
        })
        // target=_blank and window.open never make a second app window.
        .on_new_window(move |url, _features| {
            match policy::decide(&url, &win_server) {
                policy::Nav::Stay => {
                    if let Some(w) = win_app.get_webview_window(MAIN) {
                        let _ = w.navigate(url);
                    }
                }
                policy::Nav::Browser => open_external(&win_app, &url),
                policy::Nav::Block => {}
            }
            NewWindowResponse::Deny
        })
        .build();
    match built {
        Ok(w) => {
            *st.main_server.lock().unwrap() = Some(server.clone());
            if show {
                reveal(&w);
            }
        }
        Err(e) => eprintln!("[desktop] could not open the app window: {e}"),
    }
}

fn open_external<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("[desktop] could not open a link in the browser: {e}");
    }
}

fn reveal<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Tray click, second launch, dock click: the app if it is connected, else
/// the setup screen (and another try in the background).
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN) {
        Some(w) if *shell(app).status.lock().unwrap() == Status::Online => reveal(&w),
        _ => {
            open_setup(app);
            let app = app.clone();
            std::thread::spawn(move || connect(&app, true));
        }
    }
}

fn open_setup<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(SETUP) {
        reveal(&w);
        return;
    }
    let built = WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title(format!("{} \u{00b7} Server", product(app)))
        .inner_size(520.0, 600.0)
        .min_inner_size(360.0, 420.0)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("[desktop] could not open the setup window: {e}");
    }
}

// ---- notifications ------------------------------------------------------------

/// Poll the server's feed for as long as this connect is current.
fn follow_feed<R: Runtime>(app: AppHandle<R>, server: Url, gen: u64) {
    std::thread::spawn(move || {
        let mut since: Option<String> = None;
        let mut seen = feed::Seen::new(1000);
        loop {
            let enabled = shell(&app).settings.lock().unwrap().notifications;
            let cookie = enabled.then(|| session_cookie(&app, &server)).flatten();
            match cookie {
                // Off, or not signed in: the next poll starts afresh, so turning
                // it back on (or signing in) replays nothing.
                None => since = None,
                Some(cookie) => match feed::poll(&server, since.as_deref(), &cookie) {
                    feed::Outcome::Page(page) => {
                        for e in page.events {
                            if since.is_some() && seen.first(&e.key) {
                                notify(&app, &e.title, &e.body);
                            }
                        }
                        since = Some(page.cursor);
                    }
                    feed::Outcome::SignedOut => since = None,
                    feed::Outcome::Failed(e) => eprintln!("[desktop] feed: {e}"),
                },
            }
            if !sleep_while_current(&app, gen, feed::INTERVAL) {
                return;
            }
        }
    });
}

/// The app window's cookies for the server, as a `Cookie` header. Read on
/// this background thread: WebView2 deadlocks if asked on the main thread.
fn session_cookie<R: Runtime>(app: &AppHandle<R>, server: &Url) -> Option<String> {
    let cookies = app.get_webview_window(MAIN)?.cookies_for_url(server.clone()).ok()?;
    feed::cookie_header(cookies.iter().map(|c| (c.name(), c.value())))
}

fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[desktop] notification failed: {e}");
    }
}

// ---- updates ------------------------------------------------------------------

/// Only when the build configured the updater (see README "Updates").
fn watch_updates<R: Runtime>(app: AppHandle<R>) {
    use tauri_plugin_updater::UpdaterExt;
    std::thread::spawn(move || loop {
        let found = app
            .updater()
            .map_err(|e| e.to_string())
            .and_then(|u| tauri::async_runtime::block_on(u.check()).map_err(|e| e.to_string()));
        match found {
            Ok(Some(update)) => {
                let fresh = shell(&app)
                    .update
                    .lock()
                    .unwrap()
                    .replace(update.clone())
                    .is_none_or(|old| old.version != update.version);
                if fresh {
                    notify(
                        &app,
                        "Update available",
                        &format!("Version {} is ready. Install it from the tray menu.", update.version),
                    );
                }
                refresh_tray(&app);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[desktop] update check failed: {e}"),
        }
        std::thread::sleep(UPDATE_EVERY);
    });
}

fn install_update<R: Runtime>(app: &AppHandle<R>) {
    let Some(update) = shell(app).update.lock().unwrap().clone() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The plugin verifies the download against the build's public key.
        match update.download_and_install(|_, _| {}, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => notify(&app, "Update failed", &e.to_string()),
        }
    });
}

// ---- tray ---------------------------------------------------------------------

fn tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let st = shell(app);
    let notifications = st.settings.lock().unwrap().notifications;
    let name = product(app);
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "open",
        format!("Open {name}"),
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "setup",
        "Server settings\u{2026}",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "notify",
        "Notifications",
        true,
        notifications,
        None::<&str>,
    )?)?;
    let auto = app.autolaunch().is_enabled().unwrap_or(false);
    menu.append(&CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        auto,
        None::<&str>,
    )?)?;
    if let Some(u) = st.update.lock().unwrap().as_ref() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            "update",
            format!("Install update {} and restart", u.version),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        format!("Quit {name}"),
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn refresh_tray<R: Runtime>(app: &AppHandle<R>) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn handle_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "open" => show_main(app),
        "setup" => open_setup(app),
        "notify" => {
            let on = !shell(app).settings.lock().unwrap().notifications;
            let _ = set_notifications_inner(app, on);
        }
        "autostart" => {
            let on = app.autolaunch().is_enabled().unwrap_or(false);
            let _ = set_autostart_inner(app, !on);
        }
        "update" => install_update(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

// ---- commands: the setup window only (capabilities/setup.json, build.rs) -------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    name: String,
    version: String,
    server: String,
    default_server: String,
    custom: bool,
    status: Status,
    notifications: bool,
    autostart: bool,
}

fn view<R: Runtime>(app: &AppHandle<R>) -> View {
    let st = shell(app);
    let s = st.settings.lock().unwrap().clone();
    let status = st.status.lock().unwrap().clone();
    View {
        name: product(app),
        version: app.package_info().version.to_string(),
        server: s.server().to_string(),
        default_server: settings::default_server().to_string(),
        custom: s.server_url.is_some(),
        status,
        notifications: s.notifications,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

fn save_settings<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let st = shell(app);
    let mut s = st.settings.lock().unwrap();
    let mut next = s.clone();
    change(&mut next);
    next.save(&st.path)?;
    *s = next;
    Ok(())
}

fn set_notifications_inner<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    save_settings(app, |s| s.notifications = on)?;
    refresh_tray(app);
    Ok(())
}

fn set_autostart_inner<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    refresh_tray(app);
    Ok(())
}

#[tauri::command]
fn get_state<R: Runtime>(app: AppHandle<R>) -> View {
    view(&app)
}

/// Save the server address (empty = back to the build's default) and connect.
#[tauri::command]
async fn set_server<R: Runtime>(app: AppHandle<R>, url: String) -> Result<View, String> {
    let next = if url.trim().is_empty() {
        None
    } else {
        Some(settings::normalize_server(&url)?.to_string())
    };
    save_settings(&app, |s| s.server_url = next)?;
    reconnect(app).await
}

#[tauri::command]
async fn retry<R: Runtime>(app: AppHandle<R>) -> Result<View, String> {
    reconnect(app).await
}

async fn reconnect<R: Runtime>(app: AppHandle<R>) -> Result<View, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || connect(&a, true))
        .await
        .map_err(|e| e.to_string())?;
    Ok(view(&app))
}

#[tauri::command]
fn set_notifications<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<View, String> {
    set_notifications_inner(&app, on)?;
    Ok(view(&app))
}

#[tauri::command]
fn set_autostart<R: Runtime>(app: AppHandle<R>, on: bool) -> Result<View, String> {
    set_autostart_inner(&app, on)?;
    Ok(view(&app))
}

// ---- wiring -------------------------------------------------------------------

/// Everything but the tray and the first connect, so tests can build the app
/// on tauri's mock runtime with the REAL capabilities and command list.
fn configure<R: Runtime>(b: tauri::Builder<R>, updater: bool) -> tauri::Builder<R> {
    let mut b = b
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[SETUP])
                // We decide visibility (tray, --hidden); the plugin keeps the rest.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        );
    // Registered only when configured: with no `plugins.updater` in the
    // config the plugin refuses to initialise (it requires a public key).
    if updater {
        b = b.plugin(tauri_plugin_updater::Builder::new().build());
    }
    b.invoke_handler(tauri::generate_handler![
        get_state,
        set_server,
        retry,
        set_notifications,
        set_autostart
    ])
    .setup(move |app| {
        let path = app.path().app_config_dir()?.join("settings.json");
        app.manage(Shell::new(path, updater));
        Ok(())
    })
    .on_window_event(|window, event| {
        // Closing the app window hides it; the tray brings it back as it was.
        if let WindowEvent::CloseRequested { api, .. } = event {
            if window.label() == MAIN {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    })
}

/// Tray, first connect, update watch: what only the real app does.
fn start(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip(product(app))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()))
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    let show = !std::env::args().any(|a| a == HIDDEN_ARG);
    let handle = app.clone();
    std::thread::spawn(move || connect(&handle, show));
    if shell(app).updater {
        watch_updates(app.clone());
    }
    Ok(())
}

pub fn run() {
    let context = tauri::generate_context!();
    let updater = context.config().plugins.0.contains_key("updater");
    // Single instance first, so a second launch is caught before anything
    // else starts. Not in `configure`: in a test process every mock app
    // after the first would find "another instance" and exit the process.
    let first = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)));
    configure(first, updater)
        .build(context)
        .expect("failed to build the desktop shell")
        .run(|app, event| match event {
            RunEvent::Ready => {
                if let Err(e) = start(app) {
                    eprintln!("[desktop] could not start: {e}");
                    app.exit(1);
                }
            }
            // No window left is not a reason to quit: the tray is the app.
            RunEvent::ExitRequested { api, code: None, .. } => api.prevent_exit(),
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests;
