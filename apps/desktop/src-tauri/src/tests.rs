//! The security boundary, tested on tauri's mock runtime with the app's REAL
//! capabilities (capabilities/*.json) and command list: the remote app window
//! can call nothing, and the local setup window only our own commands.

use super::{configure, Shell};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::Manager;
use tauri::{WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LOCAL: &str = "tauri://localhost";
const REMOTE: &str = "http://localhost:3200/";

fn app() -> tauri::App<MockRuntime> {
    let app = configure(mock_builder(), false)
        .build(tauri::generate_context!())
        .expect("the app builds on the mock runtime");
    // The mock runtime does not run `setup`; nothing here touches the file.
    let path = std::env::temp_dir().join(format!("desktop-acl-test-{}", std::process::id()));
    app.manage(Shell::new(path.join("settings.json"), false));
    app
}

fn window(app: &tauri::App<MockRuntime>, label: &str, url: WebviewUrl) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, url).build().unwrap()
}

fn invoke(w: &WebviewWindow<MockRuntime>, cmd: &str, from: &str, body: serde_json::Value) -> Result<(), String> {
    get_ipc_response(
        w,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: from.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Every command the app or a plugin it registers exposes, as the JS side names it.
const EVERY_COMMAND: &[(&str, &str)] = &[
    ("get_state", "{}"),
    ("set_server", r#"{"url":"https://evil.test"}"#),
    ("retry", "{}"),
    ("set_notifications", r#"{"on":true}"#),
    ("set_autostart", r#"{"on":true}"#),
    ("plugin:notification|notify", r#"{"options":{"title":"x"}}"#),
    ("plugin:notification|request_permission", "{}"),
    ("plugin:opener|open_url", r#"{"url":"file:///etc/passwd"}"#),
    ("plugin:opener|open_path", r#"{"path":"/bin/sh"}"#),
    ("plugin:autostart|enable", "{}"),
    ("plugin:window-state|save_window_state", r#"{"flags":0}"#),
    ("plugin:window|close", "{}"),
    ("plugin:webview|create_webview_window", "{}"),
    ("plugin:event|emit", r#"{"event":"x"}"#),
    ("plugin:app|version", "{}"),
];

fn denied(r: Result<(), String>, what: &str) {
    let e = r.expect_err(what);
    assert!(e.contains("not allowed"), "{what}: expected an ACL refusal, got {e}");
}

#[test]
fn the_remote_app_window_gets_no_ipc_at_all() {
    let app = app();
    let main = window(&app, "main", WebviewUrl::External(REMOTE.parse().unwrap()));
    for (cmd, body) in EVERY_COMMAND {
        let body = serde_json::from_str(body).unwrap();
        denied(invoke(&main, cmd, REMOTE, body), &format!("{cmd} from the app window"));
    }
}

#[test]
fn a_remote_page_in_the_setup_window_gets_nothing_either() {
    // If the setup window were ever navigated away from the bundled page.
    let app = app();
    let setup = window(&app, "setup", WebviewUrl::App("index.html".into()));
    for (cmd, body) in EVERY_COMMAND {
        let body = serde_json::from_str(body).unwrap();
        denied(
            invoke(&setup, cmd, "https://evil.test/", body),
            &format!("{cmd} from a remote page in setup"),
        );
    }
}

#[test]
fn the_local_setup_page_may_call_our_commands_and_nothing_else() {
    let app = app();
    let setup = window(&app, "setup", WebviewUrl::App("index.html".into()));
    invoke(&setup, "get_state", LOCAL, serde_json::json!({})).expect("get_state from setup");
    for (cmd, body) in EVERY_COMMAND.iter().filter(|(c, _)| c.starts_with("plugin:")) {
        let body = serde_json::from_str(body).unwrap();
        denied(invoke(&setup, cmd, LOCAL, body), &format!("{cmd} from setup"));
    }
}

#[test]
fn local_content_in_any_other_window_is_refused() {
    let app = app();
    let other = window(&app, "main", WebviewUrl::App("index.html".into()));
    denied(
        invoke(&other, "get_state", LOCAL, serde_json::json!({})),
        "get_state from main",
    );
}
