//! The server's notification feed (`desktop.feed`, a tRPC query in
//! packages/api/src/routers/desktop.ts) turned into OS notifications.
//!
//! Polled, with the session the user signed in with in the app window: its
//! cookies are read from the window's cookie store and sent to the SAME origin
//! only. No token of our own is minted or stored. Signed out (or the session
//! expired) = the feed answers 401 and nothing is shown until they sign in.
//!
//! The server builds each event's title and body; this side only shows each
//! `key` once. Pure apart from `poll`.

use serde::Deserialize;
use std::collections::{HashSet, VecDeque};
use std::time::Duration;
use url::Url;

pub const INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize, PartialEq)]
pub struct Event {
    pub key: String,
    /// "proposal" | "inbound" | "agent_run" (anything else: a generic label).
    #[serde(default)]
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// One OS notification.
#[derive(Debug, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
}

/// What a poll's new events look like on screen. With `details` (opt-in, tray
/// menu): one notification per event, as the server worded it, which can put
/// a sender and a subject on a lock screen. Without (the default): one
/// notification per KIND, saying only that and how many, e.g. "New email" or
/// "3 new messages", and nothing about who or what.
pub fn notes(events: &[&Event], details: bool, app: &str) -> Vec<Note> {
    if details {
        return events
            .iter()
            .map(|e| Note {
                title: e.title.clone(),
                body: e.body.clone(),
            })
            .collect();
    }
    let mut kinds: Vec<(&str, Vec<&Event>)> = Vec::new();
    for e in events {
        match kinds.iter_mut().find(|(k, _)| *k == e.kind) {
            Some((_, list)) => list.push(e),
            None => kinds.push((&e.kind, vec![e])),
        }
    }
    kinds
        .into_iter()
        .map(|(kind, list)| {
            let n = list.len();
            let title = if n == 1 {
                list[0].title.clone()
            } else {
                match kind {
                    "proposal" => format!("{n} approvals waiting"),
                    "inbound" => format!("{n} new messages"),
                    "agent_run" => format!("{n} agent runs finished"),
                    _ => format!("{n} updates"),
                }
            };
            Note {
                title,
                body: format!("Open {app} to see {}.", if n == 1 { "it" } else { "them" }),
            }
        })
        .collect()
}

#[derive(Debug, Deserialize, PartialEq)]
pub struct Page {
    pub cursor: String,
    pub events: Vec<Event>,
}

#[derive(Debug, PartialEq)]
pub enum Outcome {
    Page(Page),
    /// Not signed in (401) or no org (403): wait for the user.
    SignedOut,
    /// Anything else: offline, 5xx, a server without the feed. Try later.
    Failed(String),
}

/// `GET <server>/api/trpc/desktop.feed?input=...`. tRPC's superjson transformer
/// wraps the input as `{"json": ...}`; a plain string field needs no `meta`.
pub fn feed_url(server: &Url, since: Option<&str>) -> Url {
    let input = match since {
        Some(s) => serde_json::json!({ "json": { "since": s } }),
        None => serde_json::json!({ "json": {} }),
    };
    let mut url = server.join("/api/trpc/desktop.feed").expect("a static path joins");
    url.query_pairs_mut().append_pair("input", &input.to_string());
    url
}

/// A tRPC response body, by HTTP status.
pub fn parse(status: u16, body: &str) -> Outcome {
    match status {
        200 => {
            #[derive(Deserialize)]
            struct Envelope {
                result: ResultField,
            }
            #[derive(Deserialize)]
            struct ResultField {
                data: DataField,
            }
            #[derive(Deserialize)]
            struct DataField {
                json: Page,
            }
            match serde_json::from_str::<Envelope>(body) {
                Ok(e) => Outcome::Page(e.result.data.json),
                Err(e) => Outcome::Failed(format!("unexpected feed response: {e}")),
            }
        }
        401 | 403 => Outcome::SignedOut,
        s => Outcome::Failed(format!("feed answered HTTP {s}")),
    }
}

/// The `Cookie` header for a request to the server, from the window's cookies.
pub fn cookie_header<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let h = pairs
        .into_iter()
        .map(|(n, v)| format!("{n}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    (!h.is_empty()).then_some(h)
}

/// The HTTP client for talking to the server: OS-trusted certificates (like
/// the window), statuses as values, and NO redirects (one could carry the
/// Cookie header to another origin; the health probe does not need them).
pub fn agent(timeout: Duration) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(0)
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build())
        .build()
        .into()
}

/// One request. Blocking: call it from a thread of its own.
pub fn poll(server: &Url, since: Option<&str>, cookie: &str) -> Outcome {
    let agent = agent(Duration::from_secs(15));
    let res = agent
        .get(feed_url(server, since).as_str())
        .header("Cookie", cookie)
        .header("Accept", "application/json")
        .call();
    match res {
        Ok(mut r) => {
            let status = r.status().as_u16();
            match r.body_mut().with_config().limit(1 << 20).read_to_string() {
                Ok(body) => parse(status, &body),
                Err(e) => Outcome::Failed(e.to_string()),
            }
        }
        Err(e) => Outcome::Failed(e.to_string()),
    }
}

/// Remembers what was already shown, so the feed's overlap window (and a row
/// seen twice) notifies once. Bounded.
pub struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
    cap: usize,
}

impl Seen {
    pub fn new(cap: usize) -> Self {
        Seen {
            set: HashSet::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    /// True the first time `key` is offered.
    pub fn first(&mut self, key: &str) -> bool {
        if !self.set.insert(key.to_string()) {
            return false;
        }
        self.order.push_back(key.to_string());
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_trpc_query_url() {
        let s = Url::parse("https://app.example.com/").unwrap();
        let u = feed_url(&s, None);
        assert_eq!(u.path(), "/api/trpc/desktop.feed");
        assert_eq!(u.query_pairs().next().unwrap().1, r#"{"json":{}}"#);
        let u = feed_url(&s, Some("2026-11-17T10:00:00.000Z"));
        assert_eq!(
            u.query_pairs().next().unwrap().1,
            r#"{"json":{"since":"2026-11-17T10:00:00.000Z"}}"#
        );
        assert_eq!(u.origin(), s.origin(), "the cookie only ever goes to the server");
    }

    #[test]
    fn parses_pages_and_errors() {
        let body = r#"{"result":{"data":{"json":{"cursor":"c2","events":[
            {"key":"inbound:1","kind":"inbound","title":"New email","body":"a: b","at":"x"}
        ]}}}}"#;
        assert_eq!(
            parse(200, body),
            Outcome::Page(Page {
                cursor: "c2".into(),
                events: vec![Event {
                    key: "inbound:1".into(),
                    kind: "inbound".into(),
                    title: "New email".into(),
                    body: "a: b".into()
                }]
            })
        );
        let unauth = r#"{"error":{"json":{"message":"Sign in required.","code":-32001}}}"#;
        assert_eq!(parse(401, unauth), Outcome::SignedOut);
        assert_eq!(parse(403, "{}"), Outcome::SignedOut);
        assert!(matches!(parse(500, "{}"), Outcome::Failed(_)));
        assert!(matches!(parse(404, "<html>"), Outcome::Failed(_)));
        assert!(matches!(parse(200, "<html>captive portal</html>"), Outcome::Failed(_)));
    }

    #[test]
    fn cookie_header_joins_pairs() {
        assert_eq!(cookie_header([]), None);
        assert_eq!(
            cookie_header([("a", "1"), ("better-auth.session_token", "t.s")]).unwrap(),
            "a=1; better-auth.session_token=t.s"
        );
    }

    fn ev(key: &str, kind: &str, title: &str, body: &str) -> Event {
        Event {
            key: key.into(),
            kind: kind.into(),
            title: title.into(),
            body: body.into(),
        }
    }

    #[test]
    fn notes_say_only_what_and_how_many_by_default() {
        let a = ev("inbound:1", "inbound", "New email", "jane@x.test: Contract");
        let b = ev(
            "proposal:1",
            "proposal",
            "Waiting for your approval",
            "Delete “Payroll”",
        );
        let c = ev("inbound:2", "inbound", "New text message", "From +1555");
        let all = [&a, &b, &c];

        let quiet = notes(&all, false, "Acme");
        assert_eq!(
            quiet,
            vec![
                Note {
                    title: "2 new messages".into(),
                    body: "Open Acme to see them.".into()
                },
                Note {
                    title: "Waiting for your approval".into(),
                    body: "Open Acme to see it.".into()
                },
            ]
        );
        let text = format!("{quiet:?}");
        assert!(!text.contains("jane") && !text.contains("Payroll") && !text.contains("+1555"));

        assert_eq!(notes(&[&a], false, "Acme")[0].title, "New email");
        assert_eq!(notes(&[&b, &b], false, "Acme")[0].title, "2 approvals waiting");
        let odd = ev("x:1", "", "Something", "secret");
        assert_eq!(notes(&[&odd, &odd], false, "Acme")[0].title, "2 updates");
    }

    #[test]
    fn notes_with_details_are_one_per_event_as_the_server_worded_them() {
        let a = ev("inbound:1", "inbound", "New email", "jane@x.test: Contract");
        let b = ev("inbound:2", "inbound", "New email", "bob@x.test: Invoice");
        let n = notes(&[&a, &b], true, "Acme");
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].body, "jane@x.test: Contract");
        assert!(notes(&[], false, "Acme").is_empty());
    }

    #[test]
    fn seen_once_and_bounded() {
        let mut s = Seen::new(2);
        assert!(s.first("a"));
        assert!(!s.first("a"));
        assert!(s.first("b") && s.first("c"));
        assert!(s.first("a"), "evicted keys may notify again");
    }
}
