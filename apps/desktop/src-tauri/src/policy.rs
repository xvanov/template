//! Where the app window may go, and which links leave it. Pure; every
//! navigation and every new-window request of the remote page is decided here.
//!
//! Two different events, deliberately treated differently:
//!
//! - **A navigation** (`navigation_allowed`): the main frame OR AN IFRAME
//!   loading a URL. WebKitGTK and WKWebView report both the same way, so a
//!   navigation is never taken as the user's intent: one the window may not
//!   load is dropped, never handed to the system browser. Otherwise any page
//!   with an iframe (an embedded video, a payment widget, an ad) could launch
//!   the browser by itself.
//! - **A new-window request** (`new_window`): a `target=_blank` link, or a
//!   click on a link to another site, which `CLICK_SCRIPT` turns into one. That
//!   is the user asking to leave, so ordinary links (http, https, mailto, tel)
//!   open outside.
//!
//! The window is locked to the server's origin; it has no IPC either way
//! (capabilities/), so this is not what keeps a page from calling the app. It
//! keeps the user from mistaking another site for the app, in an app-shaped
//! window, with the app's cookie jar.

use url::Url;

/// Sign-in pages that must run INSIDE the window, because the session they
/// create has to land in its cookie jar. Google sign-in (better-auth's Google
/// provider) is the only one the template has. https only. Google may refuse
/// embedded browsers ("This browser or app may not be secure"); see README.
pub const IN_WINDOW_ORIGINS: &[&str] = &["https://accounts.google.com"];

/// Extra origins the page may load in the window (iframes: a payment widget, a
/// video player), comma-separated, https only: `DESKTOP_EMBED_ORIGINS` at build
/// time. Navigations cannot tell an iframe from the main frame, so these may
/// also replace the app in the window; list only origins you would trust there.
pub const EMBED_ORIGINS_ENV: Option<&str> = option_env!("DESKTOP_EMBED_ORIGINS");

/// Injected into the app window's main frame: a plain left click on a link to
/// another origin becomes `window.open`, i.e. a new-window request the shell
/// sends to the system browser (see `new_window`). Runs after the page's own
/// handlers (bubble phase on `window`), and leaves alone any click the page
/// already handled. `__SERVER_ORIGIN__` is replaced with the server's origin.
pub const CLICK_SCRIPT: &str = r#"(() => {
  if (window.top !== window || location.origin !== __SERVER_ORIGIN__) return;
  window.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a || a.hasAttribute("download")) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin === location.origin) return;
    if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return;
    e.preventDefault();
    window.open(url.href, "_blank");
  });
})();"#;

/// What to do with a new-window request.
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Load it in the app window (never a second window).
    Stay,
    /// Hand it to the system browser (or mail / phone app).
    Browser,
    /// Drop it.
    Block,
}

/// The click script, bound to the server's origin.
pub fn click_script(server: &Url) -> String {
    let origin = serde_json::to_string(&server.origin().ascii_serialization()).expect("a string serializes");
    CLICK_SCRIPT.replace("__SERVER_ORIGIN__", &origin)
}

/// The embeddable origins from a comma-separated list; anything that is not an
/// https URL with a host is ignored.
pub fn parse_origins(raw: Option<&str>) -> Vec<Url> {
    raw.unwrap_or("")
        .split(',')
        .filter_map(|s| Url::parse(s.trim()).ok())
        .filter(|u| u.scheme() == "https" && u.host_str().is_some())
        .filter_map(|u| Url::parse(&u.origin().ascii_serialization()).ok())
        .collect()
}

fn same_origin(target: &Url, other: &Url) -> bool {
    let o = target.origin();
    o.is_tuple() && o == other.origin()
}

fn in_window_origin(target: &Url) -> bool {
    target.scheme() == "https"
        && IN_WINDOW_ORIGINS
            .iter()
            .filter_map(|o| Url::parse(o).ok())
            .any(|o| same_origin(target, &o))
}

/// May the window (or a frame in it) load `target`? False = drop it, silently.
pub fn navigation_allowed(target: &Url, server: &Url, embeddable: &[Url]) -> bool {
    // `about:blank` / `about:srcdoc`: origin-less blank documents that pages
    // create for their own use; they load nothing from anywhere.
    target.scheme() == "about"
        // `origin()` sees through `blob:<origin>/<uuid>`, so a blob the app
        // made itself counts as the app's.
        || same_origin(target, server)
        || in_window_origin(target)
        || embeddable.iter().any(|e| same_origin(target, e))
}

/// A new-window request: the user clicked a link that leaves (or a page asked).
pub fn new_window(target: &Url, server: &Url) -> Nav {
    if target.scheme() != "about" && (same_origin(target, server) || in_window_origin(target)) {
        return Nav::Stay;
    }
    match target.scheme() {
        "http" | "https" | "mailto" | "tel" => Nav::Browser,
        // file:, data:, blob: of another origin, custom schemes that would
        // launch a local program. (`javascript:` URLs are not navigations at
        // all: the page runs them as its own script, which it could anyway.)
        _ => Nav::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "https://app.example.com/";

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }
    fn nav(target: &str, server: &str, embed: &[Url]) -> bool {
        navigation_allowed(&u(target), &u(server), embed)
    }
    fn win(target: &str, server: &str) -> Nav {
        new_window(&u(target), &u(server))
    }

    #[test]
    fn the_server_loads_in_the_window() {
        for t in [
            "https://app.example.com/app/settings?x=1#y",
            "https://app.example.com:443/login",
            "blob:https://app.example.com/5f1c-uuid",
            "about:blank",
            "about:srcdoc",
            "https://accounts.google.com/o/oauth2/v2/auth?x",
        ] {
            assert!(nav(t, S, &[]), "{t}");
        }
        assert!(nav("http://localhost:3200/app", "http://localhost:3200/", &[]));
    }

    #[test]
    fn other_origins_are_dropped_not_opened() {
        // An iframe (or a script) loading any of these: nothing loads, and
        // nothing launches the browser either.
        for t in [
            "http://app.example.com/",       // scheme
            "https://app.example.com:8443/", // port
            "https://evil.app.example.com/", // subdomain
            "https://app.example.com.evil.test/",
            "https://www.youtube.com/embed/x",
            "https://example.com/",
            "http://accounts.google.com/",
            "mailto:jane@example.com",
            "file:///etc/passwd",
            "data:text/html,<h1>hi</h1>",
            "blob:https://evil.test/uuid",
            "tauri://localhost/index.html",
            "ms-settings:privacy",
            "vscode://open?x",
        ] {
            assert!(!nav(t, S, &[]), "{t}");
        }
        assert!(!nav("http://localhost:3201/", "http://localhost:3200/", &[]));
    }

    #[test]
    fn embeddable_origins_load_and_only_those() {
        let embed = parse_origins(Some(
            " https://js.stripe.com , https://www.youtube-nocookie.com/embed/ignored-path, http://insecure.test, nonsense,",
        ));
        assert_eq!(
            embed.iter().map(Url::as_str).collect::<Vec<_>>(),
            ["https://js.stripe.com/", "https://www.youtube-nocookie.com/"]
        );
        assert!(nav("https://js.stripe.com/v3/frame.html", S, &embed));
        assert!(nav("https://www.youtube-nocookie.com/embed/abc", S, &embed));
        assert!(!nav("http://insecure.test/", S, &embed));
        assert!(!nav("https://evil.stripe.com/", S, &embed));
        assert!(parse_origins(None).is_empty());
    }

    #[test]
    fn clicked_links_to_other_sites_open_outside() {
        for t in [
            "https://docs.example.com/guide",
            "http://app.example.com/",
            "https://evil.app.example.com/",
            "mailto:jane@example.com",
            "tel:+15551234567",
        ] {
            assert_eq!(win(t, S), Nav::Browser, "{t}");
        }
    }

    #[test]
    fn new_windows_for_the_app_stay_in_the_app_window() {
        assert_eq!(win("https://app.example.com/app/reports", S), Nav::Stay);
        assert_eq!(win("https://accounts.google.com/o/oauth2/v2/auth", S), Nav::Stay);
    }

    #[test]
    fn new_windows_for_anything_else_are_dropped() {
        for t in [
            "file:///etc/passwd",
            "data:text/html,<h1>hi</h1>",
            "about:blank",
            "blob:https://evil.test/uuid",
            "tauri://localhost/index.html",
            "ms-settings:privacy",
            "vscode://open?x",
        ] {
            assert_eq!(win(t, S), Nav::Block, "{t}");
        }
    }

    #[test]
    fn the_click_script_is_bound_to_the_server_origin() {
        let s = click_script(&u("http://localhost:3200/app"));
        assert!(s.contains(r#"location.origin !== "http://localhost:3200""#));
        assert!(!s.contains("__SERVER_ORIGIN__"));
    }
}
