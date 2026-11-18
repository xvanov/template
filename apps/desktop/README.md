# apps/desktop: the desktop shell

A Tauri 2 app for Windows, macOS and Linux that opens the **deployed web app**
(`APP_URL`) in a window of its own and adds what a browser tab cannot:

- **Tray icon**: open, server settings, notifications on/off, start at login,
  install update (when there is one), quit. Closing the window hides it; the
  app keeps running in the tray. A left click on the icon opens the window
  (Windows, macOS; Linux tray hosts only show the menu).
- **OS notifications** for what wants the user: a proposal waiting for
  approval, a new inbound email or text, an agent run they started that
  finished or failed. The server decides what and how it is worded
  (`packages/api/src/routers/desktop.ts`); the shell only shows each event once.
- **Start at login**: off until turned on (tray or setup screen). It then
  starts with `--hidden`, in the tray only.
- **Single instance**: a second launch brings up the running one.
- **Window size and position** are remembered.
- **External links** open in the system browser.
- **Updates**, signed, when a release is configured for them (off by default).

It is a remote-URL shell: there is no copy of the web UI in it, so it is always
the deployed version. The only bundled page is `ui/`, the setup screen: the
server address, "can't connect" (with automatic retry), and the two toggles.

## Run it

Needs Rust (https://rustup.rs) and, on Linux:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev
```

macOS needs the Xcode command line tools; Windows needs the MSVC build tools
(WebView2 ships with Windows 10/11). Nothing else in the repo needs any of this:
no turbo task compiles Rust, so `make typecheck/lint/test/smoke` never touch it.

```bash
make dev                                         # the web app on :3200
make desktop                                     # the shell, pointed at it
DESKTOP_APP_URL=https://app.example.com make desktop-build   # installers for this OS
cd apps/desktop/src-tauri && cargo test          # unit tests (no window needed)
```

`make desktop-build` writes to `src-tauri/target/release/bundle/`: `.deb`,
`.rpm` and `.AppImage` on Linux; `.msi` and `-setup.exe` on Windows; `.app`
and `.dmg` on macOS. Unsigned unless the signing variables below are set.

## Configuration: one place each

| What                      | Where                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Name, identifier, version | `src-tauri/tauri.conf.json` (`productName`, `identifier`, `version`)         |
| Icons                     | `npm run icons -w desktop` regenerates them from `apps/web/src/app/icon.svg` |
| Default server            | `DESKTOP_APP_URL` at build time (default `http://localhost:3200`)            |
| Server, per install       | the setup screen (tray, "Server settings…"); saved in `settings.json`        |
| Updater, signing          | environment variables at build time, below; never in a committed file        |

`productName` is what the window, tray and installers are called; the
`identifier` (reverse DNS, e.g. `com.acme.app`) names the config and data
directories, so changing it after release orphans users' settings and
sign-in. `settings.json` lives in the app config dir
(`~/.config/<identifier>/` on Linux, `%APPDATA%\<identifier>\` on Windows,
`~/Library/Application Support/<identifier>/` on macOS).

The server address is reduced to its **origin** (`https://host[:port]`); the
web app must be served at the root of it, as this template's is. The web app
needs nothing new for the shell: it is a browser like any other, with the same
cookies, CSRF checks and `TRUSTED_ORIGINS`.

## Security model

What the shell must protect: the user's machine from the web content it loads,
and the user's session from going anywhere but the server.

1. **The remote page has no IPC.** The app window loads the server, a remote
   origin. Tauri checks every call from a remote origin against the
   capabilities, and no capability names that window or any remote URL
   (`src-tauri/capabilities/setup.json` is the only one). So the web app,
   and anything injected into it by an XSS, cannot call a single command:
   not ours, not a plugin's (notifications, opener, autostart), not Tauri's
   own (window, webview, event). `withGlobalTauri` is off, so the page does
   not even get the JS API wrapper, only Tauri's internal IPC bridge, which
   refuses it.
2. **The local page gets five commands and nothing else.** The setup screen
   (`ui/`) may call exactly the app's own commands (`build.rs` declares them,
   which makes Tauri permission-check them too), only from the bundled origin,
   only in the window labelled `setup`. No plugin permission, no `core:default`.
   `src/tests.rs` builds the real app on Tauri's mock runtime and proves all
   of it: every command is refused from the remote window, from a remote page
   in the setup window, and from local content in any other window; the setup
   page gets its commands and no plugin's. Run `cargo test`.
3. **The window stays on the server's origin** (`src/policy.rs`). Same
   origin (scheme, host and port) loads in the window. `https://accounts.google.com`
   also stays, because Google sign-in must set the session in this window's
   cookie jar. Other `http(s)`, `mailto:` and `tel:` links open in the system
   browser or mail/phone app; anything else (`file:`, `javascript:`, `data:`,
   custom schemes that could launch local programs) is dropped. `target=_blank`
   and `window.open` never create a second app window. A redirect to another
   origin counts as leaving: set `APP_URL` to the address the app answers on
   (with `https://` if it redirects there).
4. **CSP on the local page** (`tauri.conf.json`): `default-src 'none'`, scripts
   and styles only from the bundle, IPC as the only connection, no forms
   posting anywhere, no framing. The remote page keeps the CSP its server sends.
5. **The session cookie goes only to the server.** Notifications poll
   `desktop.feed` (a tRPC query) with the cookies the window's cookie store
   holds for the server's URL, sent to that origin only, never following
   redirects. The shell mints, stores and logs no token of its own; signing
   out in the window stops the notifications.
6. **Updates are signed.** The updater only installs a bundle whose signature
   verifies against the public key compiled in; the private key lives only in
   CI secrets. With no key configured, the updater plugin is not even loaded.

Out of scope: a compromised server (the shell shows whatever the server
serves, as a browser would), and malware already running as the user.

Why polling and not a subscription: the events are written by the worker, a
different process, and the template has no cross-process pub/sub, so a tRPC
subscription would itself poll the database for each open connection, and
hold a long-lived stream open through every proxy and tunnel in between. A
poll every 30 s costs the same queries and needs no reconnect logic.

## Updates (off by default)

1. Generate a key pair once, on a trusted machine, and keep the private key
   out of the repo (`*.tauri.key` is in `.gitignore` as a backstop):

   ```bash
   npm run tauri -w desktop -- signer generate -w ~/.tauri/app.key
   ```

2. In the GitHub repo settings, add
   - secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of `app.key`) and
     `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
   - variables `DESKTOP_UPDATER_PUBKEY` (the contents of `app.key.pub`) and
     `DESKTOP_UPDATER_ENDPOINT`, for GitHub Releases:
     `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`;
   - variable `DESKTOP_APP_URL`, the production web address.

3. Bump `version` in `tauri.conf.json`, then
   `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`. The `release`
   job of `.github/workflows/desktop.yml` builds every OS, signs the update
   bundles, and attaches them and `latest.json` to a **draft** release.
   Publish the draft; running apps find it within 12 hours (and at start),
   notify once, and offer "Install update … and restart" in the tray.

`releases/latest` only sees published, non-prerelease releases, so a draft
reaches nobody. A local build gets the updater the same way: set the two
`DESKTOP_UPDATER_*` variables and `TAURI_SIGNING_PRIVATE_KEY` before
`make desktop-build` (`scripts/tauri.mjs` refuses half a configuration).

## Signing

Unsigned builds work, but Windows SmartScreen warns about them and macOS
Gatekeeper refuses to open them without a right-click → Open. Each kind of
signing turns on in the release job when its secrets exist:

- **macOS** (Developer ID + notarisation): secrets `APPLE_CERTIFICATE`
  (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Acme (TEAMID)`);
  for notarisation also `APPLE_ID`, `APPLE_PASSWORD` (an app-specific
  password) and `APPLE_TEAM_ID`. The Tauri CLI reads these itself.
- **Windows** (Authenticode): secrets `WINDOWS_CERTIFICATE` (base64 of the
  `.pfx`) and `WINDOWS_CERTIFICATE_PASSWORD`. The job imports it and passes
  its thumbprint as `DESKTOP_WINDOWS_CERT_THUMBPRINT`. A certificate on a
  hardware token or in a cloud HSM (now the norm for new OV/EV certificates)
  needs `bundle.windows.signCommand` instead; see Tauri's Windows signing docs.
- **Linux**: packages are not signed; publish checksums with the release.

## CI

`.github/workflows/desktop.yml`, separate from the main CI on purpose, runs
only when `apps/desktop/**` or the workflow changes (or by hand, or on a
`desktop-v*` tag): `cargo fmt --check`, `clippy -D warnings` and `cargo test`
on Linux, and unsigned bundles for Linux, Windows and macOS uploaded as
artifacts. It installs only the Tauri CLI (`npm ci -w desktop`), not the
monorepo.

## Known limits

- **Google sign-in in the window** may be refused by Google ("This browser or
  app may not be secure"): Google blocks some embedded browsers. Email and
  password always work. The fix, if it bites, is sign-in in the system browser
  with a deep link back to the app, which this template does not have yet.
- Clicking a notification does not open the item; it is only a heads-up.
- The "can't connect" screen covers start-up and reconnects. If the server
  goes away while the window is open, the page shows the webview's own error;
  "Try again" on the setup screen (tray → Server settings…) reconnects.
- File downloads from the web app use the webview's default handling.
- macOS builds are Apple silicon only (`macos-latest`); add
  `--target universal-apple-darwin` to the release for Intel Macs.
