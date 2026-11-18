// The app's own commands get an ACL manifest, so they are permission-checked
// like plugin commands: without one, ANY local page in ANY window could call
// them. capabilities/setup.json grants them to the setup window only.
const COMMANDS: &[&str] = &["get_state", "set_server", "retry", "set_notifications", "set_autostart"];

fn main() {
    // settings.rs bakes the default server address in at compile time.
    println!("cargo:rerun-if-env-changed=DESKTOP_APP_URL");
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri build script failed");
}
