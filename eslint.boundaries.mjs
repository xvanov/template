/**
 * Import boundaries that every workspace must respect, as ESLint rules so a
 * violation is a red squiggle in the editor and a failed `make lint`, not a
 * surprise in review.
 *
 * Mail libraries and provider SDKs may only be imported by
 * packages/email/src/transport.ts, and only packages/notify/src/ntfy.ts may
 * read the ntfy server URL and token, so every message has to go through the
 * outbound guard (CLAUDE.md rule 8). Used by the root eslint.config.mjs (all
 * packages + the worker) and by apps/web's own config.
 */
const MAIL_SDKS = [
  "nodemailer",
  "nodemailer/*",
  "@sendgrid/*",
  "resend",
  "postmark",
  "mailgun.js",
  "mailgun-js",
  "twilio",
  "@aws-sdk/client-ses",
  "@aws-sdk/client-sesv2",
];
const MESSAGE =
  "Outbound messages go through the guard: use sendMail from @repo/email (CLAUDE.md rule 8). Only packages/email/src/transport.ts may import a mail library.";
const SDK_RE =
  "/^(nodemailer|@sendgrid\\u002F|resend$|postmark$|mailgun|twilio|@aws-sdk\\u002Fclient-ses)/";

const NTFY_MESSAGE =
  "Pushes go through the guard: use notifyOperator from @repo/notify (CLAUDE.md rule 8). Only packages/notify/src/ntfy.ts may read NTFY_URL / NTFY_TOKEN.";
const NTFY_RE = "/^NTFY_(URL|TOKEN)$/";

const mailSyntax = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${SDK_RE}]`,
    message: MESSAGE,
  },
  { selector: `ImportExpression[source.value=${SDK_RE}]`, message: MESSAGE },
];
// Nothing but the push transport may build an ntfy request: reading the server
// URL or the token (env().NTFY_URL, e["NTFY_TOKEN"]) is how one would start.
const pushSyntax = [
  {
    selector: `MemberExpression[property.name=${NTFY_RE}]`,
    message: NTFY_MESSAGE,
  },
  {
    selector: `MemberExpression[property.value=${NTFY_RE}]`,
    message: NTFY_MESSAGE,
  },
];

/**
 * @param {{ mail: string, push: string }} transports the one file allowed to
 *   reach each provider, relative to the config's directory ("__none__" = none)
 */
export function outboundBoundary({ mail, push }) {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [{ group: MAIL_SDKS, message: MESSAGE }] },
        ],
        "no-restricted-syntax": ["error", ...mailSyntax, ...pushSyntax],
      },
    },
    {
      files: [mail],
      rules: {
        "no-restricted-imports": "off",
        "no-restricted-syntax": ["error", ...pushSyntax],
      },
    },
    {
      // The push transport, and its own tests (which point NTFY_URL at a fake).
      files: [push, push.replace(/\.ts$/, ".test.ts")],
      rules: { "no-restricted-syntax": ["error", ...mailSyntax] },
    },
  ];
}
