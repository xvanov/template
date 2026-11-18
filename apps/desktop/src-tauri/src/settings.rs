//! What the user chose on the setup screen, stored as `settings.json` in the
//! app's config dir. Pure apart from `load`/`save`.
//!
//! The server address is an ORIGIN (`scheme://host[:port]`): the window loads
//! it, the navigation policy keeps the window on it, and the notification feed
//! sends the session cookie only to it. A path or query typed into the setup
//! screen is dropped rather than half-honoured.

use serde::{Deserialize, Serialize};
use std::path::Path;
use url::Url;

/// The server a fresh install opens: `DESKTOP_APP_URL` at build time, else the
/// local dev server (`make dev`, port 3200).
pub const DEFAULT_SERVER: &str = match option_env!("DESKTOP_APP_URL") {
    Some(u) => u,
    None => "http://localhost:3200",
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Set on the setup screen; None = the build's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    /// OS notifications from the server's feed. On unless turned off.
    #[serde(default = "yes")]
    pub notifications: bool,
}

fn yes() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: None,
            notifications: true,
        }
    }
}

impl Settings {
    /// The origin the window opens. A stored value that no longer parses
    /// (a hand edit) falls back to the default instead of failing to start.
    pub fn server(&self) -> Url {
        self.server_url
            .as_deref()
            .and_then(|u| normalize_server(u).ok())
            .unwrap_or_else(default_server)
    }

    pub fn load(path: &Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
    }

    /// Atomic: a crash mid-write leaves the old file, never half a new one.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

pub fn default_server() -> Url {
    normalize_server(DEFAULT_SERVER).expect("DESKTOP_APP_URL must be an http(s) URL with a host")
}

/// An http(s) URL with a host, reduced to its origin, or why not.
pub fn normalize_server(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Enter the server's address.".into());
    }
    let url = Url::parse(s).map_err(|_| format!("“{s}” is not a valid address."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("The address must start with http:// or https://.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The address has no host.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Leave the user name and password out of the address.".into());
    }
    // `ascii_serialization` of an http(s) origin is `scheme://host[:port]`.
    Url::parse(&url.origin().ascii_serialization()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_the_dev_server() {
        if option_env!("DESKTOP_APP_URL").is_none() {
            assert_eq!(Settings::default().server().as_str(), "http://localhost:3200/");
        }
        assert!(Settings::default().notifications);
    }

    #[test]
    fn normalizes_to_an_origin() {
        let n = |s| normalize_server(s).map(|u| u.to_string());
        assert_eq!(
            n(" https://app.example.com/app?x=1#y ").unwrap(),
            "https://app.example.com/"
        );
        assert_eq!(n("http://box:8080").unwrap(), "http://box:8080/");
        assert_eq!(n("https://app.example.com:443/").unwrap(), "https://app.example.com/");
        assert_eq!(n("HTTPS://APP.Example.com").unwrap(), "https://app.example.com/");
        assert!(n("").is_err());
        assert!(n("app.example.com").is_err());
        assert!(n("ftp://app.example.com").is_err());
        assert!(n("file:///etc/passwd").is_err());
        assert!(n("javascript:alert(1)").is_err());
        assert!(n("https://user:pw@app.example.com").is_err());
    }

    #[test]
    fn a_broken_stored_url_falls_back_to_the_default() {
        let s = Settings {
            server_url: Some("not a url".into()),
            notifications: true,
        };
        assert_eq!(s.server(), default_server());
    }

    #[test]
    fn roundtrip_and_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("desktop-settings-test-{}", std::process::id()));
        let p = dir.join("settings.json");
        assert_eq!(Settings::load(&p), Settings::default(), "missing file = defaults");

        let s = Settings {
            server_url: Some("https://app.example.com/".into()),
            notifications: false,
        };
        s.save(&p).unwrap();
        assert_eq!(Settings::load(&p), s);
        assert!(!p.with_extension("json.tmp").exists());

        std::fs::write(&p, "{broken").unwrap();
        assert_eq!(Settings::load(&p), Settings::default(), "corrupt file = defaults");

        std::fs::write(&p, "{}").unwrap();
        assert!(Settings::load(&p).notifications, "absent field = on");
        let _ = std::fs::remove_dir_all(dir);
    }
}
