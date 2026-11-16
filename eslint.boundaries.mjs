/**
 * Import boundaries that every workspace must respect, as ESLint rules so a
 * violation is a red squiggle in the editor and a failed `make lint`, not a
 * surprise in review.
 *
 * Today: mail libraries and provider SDKs may only be imported by
 * packages/email/src/transport.ts, so every message has to go through the
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

/** @param {string} transportPath the allowed file, relative to the config's directory */
export function mailBoundary(transportPath) {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [{ group: MAIL_SDKS, message: MESSAGE }] },
        ],
        "no-restricted-syntax": [
          "error",
          {
            selector: `CallExpression[callee.name='require'][arguments.0.value=${SDK_RE}]`,
            message: MESSAGE,
          },
          {
            selector: `ImportExpression[source.value=${SDK_RE}]`,
            message: MESSAGE,
          },
        ],
      },
    },
    {
      files: [transportPath],
      rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
    },
  ];
}
