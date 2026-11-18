/**
 * The /glance page as one self-contained HTML string: no framework, no
 * external requests, a few KB. Built for Meta Ray-Ban Display glasses
 * (https://wearables.developer.meta.com/docs/develop/webapps):
 *
 *   - 600×600 additive display: BLACK IS TRANSPARENT, so the background is
 *     black and everything drawn is light. Sized from the viewport, not 600px.
 *   - Input is a D-pad on the Neural Band (arrow keys + Enter), no pointer:
 *     every row is focusable, arrows move focus, focus is plainly visible.
 *   - A slow link (~1 KB per 16 ms) and a slow CPU: no JS bundle, no fonts,
 *     one request. The startup budget is 300 KB; this page is ~5 KB.
 *   - 30 Hz panel: no animation.
 *
 * Pure (string in, string out) so it is unit-tested without a server.
 */
import type { GlanceRow, GlanceSnapshot } from "@repo/api";

/** Escape for HTML text and double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "now", "5m", "3h", "2d": the only precision a glance needs. */
export function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function rows(list: GlanceRow[], now: Date, empty: string): string {
  if (list.length === 0) return `<p class="empty" tabindex="0">${empty}</p>`;
  return `<ul>${list
    .map(
      (r) =>
        `<li tabindex="0"><span class="t">${escapeHtml(r.title)}</span>` +
        `<span class="a">${ago(r.at, now)}</span>` +
        (r.detail ? `<span class="d">${escapeHtml(r.detail)}</span>` : "") +
        `</li>`,
    )
    .join("")}</ul>`;
}

/** Counts-only links: a number, never who or what. */
function summary(n: number, what: string, empty: string): string {
  return `<p class="empty" tabindex="0">${n === 0 ? empty : `${n} ${what}. Details on your phone.`}</p>`;
}

const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#000;color:#f5f5f5;
font:400 clamp(16px,4.6vmin,30px)/1.3 system-ui,-apple-system,"Noto Sans",sans-serif}
main{height:100%;overflow-y:auto;padding:5vmin 6vmin}
h1{font-size:1em;font-weight:600;margin:0 0 .4em;display:flex;justify-content:space-between;gap:.5em}
h1 .n{min-width:1.6em;text-align:center;border-radius:.8em;background:#1f3a5f;color:#fff}
h1 .n.zero{background:#222;color:#aaa}
section{margin-bottom:1em}
ul{list-style:none;margin:0;padding:0}
li,.empty{display:grid;grid-template-columns:1fr auto;gap:0 .5em;padding:.35em .5em;margin:0 0 .25em;
border-radius:.4em;background:#111;outline:none}
li:focus,.empty:focus{background:#1f3a5f;box-shadow:0 0 0 .12em #8ab4ff}
.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.a{color:#aaa}
.d{grid-column:1/3;color:#cfcfcf;font-size:.85em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{display:block;color:#aaa}
footer{color:#888;font-size:.75em}
`;

/**
 * Arrow keys move focus between rows (the D-pad sends ArrowUp/Down), and the
 * page refreshes itself every minute while nobody is navigating.
 */
const SCRIPT = `
(function(){
var items=[].slice.call(document.querySelectorAll('[tabindex="0"]'));
if(items[0])items[0].focus();
var idle=Date.now();
document.addEventListener('keydown',function(e){
idle=Date.now();
var i=items.indexOf(document.activeElement);
if(e.key==='ArrowDown'||e.key==='ArrowRight'){i=Math.min(items.length-1,i+1)}
else if(e.key==='ArrowUp'||e.key==='ArrowLeft'){i=Math.max(0,i-1)}
else return;
e.preventDefault();
if(items[i]){items[i].focus();items[i].scrollIntoView({block:'nearest'})}
});
setInterval(function(){if(Date.now()-idle>55000)location.reload()},60000);
})();
`;

export function renderGlancePage(opts: {
  snapshot: GlanceSnapshot;
  appName: string;
  nonce: string;
  now?: Date;
}): string {
  const { snapshot: s, appName, nonce } = opts;
  const now = opts.now ?? new Date(s.at);
  const count = (n: number) =>
    `<span class="n${n === 0 ? " zero" : ""}">${n}</span>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(appName)}</title>
<style>${STYLE}</style>
</head><body><main>
<section aria-label="Waiting for approval">
<h1><span>Approvals</span>${count(s.approvals.count)}</h1>
${
  s.details
    ? rows(s.approvals.rows, now, "Nothing waiting for you.")
    : summary(
        s.approvals.count,
        "waiting for your approval",
        "Nothing waiting for you.",
      )
}
</section>
<section aria-label="Inbox">
<h1><span>Inbox</span>${count(s.inbox.unhandled)}</h1>
${
  s.details
    ? rows(s.inbox.rows, now, "Inbox is clear.")
    : summary(s.inbox.unhandled, "unhandled messages", "Inbox is clear.")
}
</section>
<footer>${escapeHtml(appName)} · updated ${now.toISOString().slice(11, 16)} UTC</footer>
</main>
<script nonce="${escapeHtml(nonce)}">${SCRIPT}</script>
</body></html>`;
}

/** Shown for an unknown or revoked link: says nothing about why. */
export function renderGlanceGone(appName: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(appName)}</title>
<style>${STYLE}</style></head><body><main>
<p class="empty" tabindex="0">This glance link is not valid. Make a new one in ${escapeHtml(appName)} on your phone or computer.</p>
</main></body></html>`;
}
