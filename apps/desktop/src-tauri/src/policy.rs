//! Where the app window may go. Pure; every navigation and every new-window
//! request of the remote page is decided here.
//!
//! The window is locked to the configured server's origin. Anything else is
//! not loaded in it: ordinary links (http, https, mailto, tel) open in the
//! user's browser, everything else (file:, javascript:, custom schemes ...) is
//! dropped. The window has no IPC either way (capabilities/), so this is not
//! what keeps a page from calling the app; it keeps the user from mistaking
//! some other site for the app, inside an app-shaped window, with the app's
//! cookies jar.

use url::Url;

/// Sign-in pages that must run INSIDE the window, because the session they
/// create has to land in its cookie jar. Google sign-in (better-auth's Google
/// provider) is the only one the template has. https only. Google may refuse
/// embedded browsers ("This browser or app may not be secure"); see README.
pub const IN_WINDOW_ORIGINS: &[&str] = &["https://accounts.google.com"];

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Load it in the app window.
    Stay,
    /// Hand it to the system browser (or mail / phone app).
    Browser,
    /// Drop it.
    Block,
}

pub fn decide(target: &Url, server: &Url) -> Nav {
    // `about:blank` (and `about:srcdoc`) are origin-less blank documents that
    // libraries create for their own use; they load nothing from anywhere.
    if target.scheme() == "about" {
        return Nav::Stay;
    }
    // `origin()` sees through `blob:<origin>/<uuid>`, so a blob the app made
    // itself counts as the app's.
    let origin = target.origin();
    if origin.is_tuple() && origin == server.origin() {
        return Nav::Stay;
    }
    if target.scheme() == "https"
        && IN_WINDOW_ORIGINS
            .iter()
            .filter_map(|o| Url::parse(o).ok())
            .any(|o| o.origin() == origin)
    {
        return Nav::Stay;
    }
    match target.scheme() {
        "http" | "https" | "mailto" | "tel" => Nav::Browser,
        _ => Nav::Block,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(target: &str, server: &str) -> Nav {
        decide(&Url::parse(target).unwrap(), &Url::parse(server).unwrap())
    }

    #[test]
    fn same_origin_stays() {
        let s = "https://app.example.com/";
        assert_eq!(d("https://app.example.com/app/inbox?x=1#y", s), Nav::Stay);
        assert_eq!(d("https://app.example.com:443/login", s), Nav::Stay);
        assert_eq!(d("blob:https://app.example.com/5f1c-uuid", s), Nav::Stay);
        assert_eq!(d("about:blank", s), Nav::Stay);
        assert_eq!(d("http://localhost:3200/app", "http://localhost:3200/"), Nav::Stay);
    }

    #[test]
    fn a_different_origin_is_a_different_site() {
        let s = "https://app.example.com/";
        // scheme, port and subdomain all change the origin
        assert_eq!(d("http://app.example.com/", s), Nav::Browser);
        assert_eq!(d("https://app.example.com:8443/", s), Nav::Browser);
        assert_eq!(d("https://evil.app.example.com/", s), Nav::Browser);
        assert_eq!(d("https://app.example.com.evil.test/", s), Nav::Browser);
        assert_eq!(d("https://docs.example.com/guide", s), Nav::Browser);
        assert_eq!(d("http://localhost:3201/", "http://localhost:3200/"), Nav::Browser);
    }

    #[test]
    fn mail_and_phone_links_go_to_their_apps() {
        let s = "https://app.example.com/";
        assert_eq!(d("mailto:jane@example.com", s), Nav::Browser);
        assert_eq!(d("tel:+15551234567", s), Nav::Browser);
    }

    #[test]
    fn everything_else_is_dropped() {
        let s = "https://app.example.com/";
        assert_eq!(d("file:///etc/passwd", s), Nav::Block);
        assert_eq!(d("javascript:alert(1)", s), Nav::Block);
        assert_eq!(d("data:text/html,<h1>hi</h1>", s), Nav::Block);
        assert_eq!(d("tauri://localhost/index.html", s), Nav::Block);
        assert_eq!(d("ms-settings:privacy", s), Nav::Block);
        assert_eq!(d("vscode://open?x", s), Nav::Block);
        // someone else's blob is nobody's business: not loaded, not handed on
        assert_eq!(d("blob:https://evil.test/uuid", s), Nav::Block);
    }

    #[test]
    fn google_sign_in_stays_but_only_over_https() {
        let s = "https://app.example.com/";
        assert_eq!(d("https://accounts.google.com/o/oauth2/v2/auth?x", s), Nav::Stay);
        assert_eq!(d("http://accounts.google.com/", s), Nav::Browser);
        assert_eq!(d("https://www.google.com/", s), Nav::Browser);
    }
}
