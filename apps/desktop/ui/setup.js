"use strict";

// The setup / offline screen. The ONLY page allowed to call the app
// (src-tauri/capabilities/setup.json), and only the five commands in
// src-tauri/build.rs. No framework, no build step: it is one form.
//
// `__TAURI_INTERNALS__.invoke` is what @tauri-apps/api's `invoke` calls; using
// it directly avoids `withGlobalTauri`, which would put the whole JS API into
// every page, the remote app window included (it could not use it, but it
// need not see it either).
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const $ = (id) => document.getElementById(id);

const AUTO_RETRY_SECONDS = 15;
let retryTimer = null;
let busy = false;

function say(text, err = false) {
  $("message").textContent = text;
  $("message").className = err ? "err" : "";
}

function render(view) {
  document.title = `${view.name} · Server`;
  $("name").textContent = view.name;
  $("version").textContent = `v${view.version}`;
  if (document.activeElement !== $("server")) {
    $("server").value = view.server.replace(/\/$/, "");
  }
  $("reset").hidden = !view.custom;
  $("reset").title = `Back to ${view.defaultServer}`;
  $("notifications").checked = view.notifications;
  $("autostart").checked = view.autostart;

  const s = view.status;
  const box = $("status");
  box.className = `card ${s.state}`;
  clearTimeout(retryTimer);
  if (s.state === "online") {
    $("status-title").textContent = "Connected";
    $("status-detail").textContent = view.server;
    $("retry").hidden = true;
  } else if (s.state === "offline") {
    $("status-title").textContent = "Can't connect";
    $("status-detail").textContent =
      `${s.message} Trying again every ${AUTO_RETRY_SECONDS} seconds.`;
    $("retry").hidden = false;
    retryTimer = setTimeout(
      () => run(() => invoke("retry")),
      AUTO_RETRY_SECONDS * 1000,
    );
  } else {
    $("status-title").textContent = "Checking the server…";
    $("status-detail").textContent = view.server;
    $("retry").hidden = true;
    retryTimer = setTimeout(refresh, 1000);
  }
}

/** Run a command that returns the new view; one at a time. */
async function run(fn, done) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    render(await fn());
    if (done) say(done);
  } catch (err) {
    say(String(err), true);
  } finally {
    busy = false;
    for (const b of document.querySelectorAll("button")) b.disabled = false;
  }
}

function refresh() {
  return run(() => invoke("get_state"));
}

$("server-form").addEventListener("submit", (e) => {
  e.preventDefault();
  say("Connecting…");
  run(() => invoke("set_server", { url: $("server").value }), "");
});
$("reset").addEventListener("click", () => {
  say("Connecting…");
  run(() => invoke("set_server", { url: "" }), "");
});
$("retry").addEventListener("click", () => {
  say("Connecting…");
  run(() => invoke("retry"), "");
});
$("notifications").addEventListener("change", (e) => {
  run(() => invoke("set_notifications", { on: e.target.checked }));
});
$("autostart").addEventListener("change", (e) => {
  run(() => invoke("set_autostart", { on: e.target.checked }));
});

refresh();
