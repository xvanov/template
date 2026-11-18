/**
 * Import boundaries that every workspace must respect, as ESLint rules so a
 * violation is a red squiggle in the editor and a failed `make lint`, not a
 * surprise in review.
 *
 * Every outbound message goes through the outbound guard (CLAUDE.md rule 8),
 * so each provider is reachable from exactly one file, its channel's transport:
 *   mail  nodemailer / resend / ...      packages/email/src/transport.ts
 *         (and RESEND_API_KEY)
 *   sms   the Twilio API host            packages/sms/src/transport.ts
 *         (and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN; that file is a small
 *         fetch client, and SMS SDKs such as `twilio` are refused everywhere)
 *   push  the ntfy URL and token         packages/notify/src/ntfy.ts
 * Used by the root eslint.config.mjs (all packages + the worker) and by
 * apps/web's own config.
 */
const MAIL_SDKS = [
  "nodemailer",
  "nodemailer/*",
  "@sendgrid/*",
  "resend",
  "postmark",
  "mailgun.js",
  "mailgun-js",
  "@aws-sdk/client-ses",
  "@aws-sdk/client-sesv2",
];
// A regex, not a gitignore-style group: "twilio/*" would also match a local
// "./twilio/route" import (the webhook's own folder).
const SMS_SDKS_REGEX =
  "^(twilio|vonage|messagebird|plivo|telnyx)(/.*)?$|^@vonage/";
const MAIL_MESSAGE =
  "Outbound messages go through the guard: use sendMail from @repo/email (CLAUDE.md rule 8). Only packages/email/src/transport.ts may import a mail library.";
const SMS_MESSAGE =
  "Outbound messages go through the guard: use sendSms from @repo/sms (CLAUDE.md rule 8). SMS SDKs are not used at all: packages/sms/src/transport.ts is the (fetch) client.";
const MAIL_RE =
  "/^(nodemailer|@sendgrid\\u002F|resend$|postmark$|mailgun|@aws-sdk\\u002Fclient-ses)/";
const SMS_RE = "/^(twilio|@vonage\\u002F|vonage$|messagebird$|plivo$|telnyx$)/";

const NTFY_MESSAGE =
  "Pushes go through the guard: use notifyOperator from @repo/notify (CLAUDE.md rule 8). Only packages/notify/src/ntfy.ts may read NTFY_URL / NTFY_TOKEN.";
const NTFY_RE = "/^NTFY_(URL|TOKEN)$/";
const RESEND_KEY_MESSAGE =
  "Only packages/email/src/transport.ts may read RESEND_API_KEY (CLAUDE.md rule 8).";
const RESEND_KEY_RE = "/^RESEND_API_KEY$/";
const TWILIO_KEY_MESSAGE =
  "Only packages/sms/src/transport.ts may read TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (CLAUDE.md rule 8).";
const TWILIO_KEY_RE = "/^TWILIO_(ACCOUNT_SID|AUTH_TOKEN)$/";
const TWILIO_HOST_MESSAGE =
  "Only packages/sms/src/transport.ts may call the Twilio API (CLAUDE.md rule 8): use sendSms from @repo/sms.";
const TWILIO_HOST_RE = "/api\\.twilio\\.com/i";

const dynamicImport = (re, message) => [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${re}]`,
    message,
  },
  { selector: `ImportExpression[source.value=${re}]`, message },
];
// Reading a credential (env().X, e["X"], process.env.X) is how a bypass starts.
const reads = (re, message) => [
  { selector: `MemberExpression[property.name=${re}]`, message },
  { selector: `MemberExpression[property.value=${re}]`, message },
];

const mailSyntax = [
  ...dynamicImport(MAIL_RE, MAIL_MESSAGE),
  ...reads(RESEND_KEY_RE, RESEND_KEY_MESSAGE),
];
const smsSdkSyntax = dynamicImport(SMS_RE, SMS_MESSAGE);
const smsSyntax = [
  ...smsSdkSyntax,
  ...reads(TWILIO_KEY_RE, TWILIO_KEY_MESSAGE),
  {
    selector: `Literal[value=${TWILIO_HOST_RE}]`,
    message: TWILIO_HOST_MESSAGE,
  },
  {
    selector: `TemplateElement[value.raw=${TWILIO_HOST_RE}]`,
    message: TWILIO_HOST_MESSAGE,
  },
];
const pushSyntax = reads(NTFY_RE, NTFY_MESSAGE);

const mailImports = { group: MAIL_SDKS, message: MAIL_MESSAGE };
const smsImports = { regex: SMS_SDKS_REGEX, message: SMS_MESSAGE };

/** A transport and its own tests (which point it at a fake). */
const withTests = (file) => [file, file.replace(/\.ts$/, ".test.ts")];

/**
 * @param {{ mail: string, push: string, sms: string }} transports the one file
 *   allowed to reach each provider, relative to the config's directory
 *   ("__none__" = none)
 */
export function outboundBoundary({ mail, push, sms }) {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [mailImports, smsImports] },
        ],
        "no-restricted-syntax": [
          "error",
          ...mailSyntax,
          ...smsSyntax,
          ...pushSyntax,
        ],
      },
    },
    {
      files: withTests(mail),
      rules: {
        "no-restricted-imports": ["error", { patterns: [smsImports] }],
        "no-restricted-syntax": ["error", ...smsSyntax, ...pushSyntax],
      },
    },
    {
      // The sms transport (the SDK stays refused here too); its tests live
      // next to the package entry point.
      files: [sms, sms.replace(/transport\.ts$/, "index.test.ts")],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [mailImports, smsImports] },
        ],
        "no-restricted-syntax": [
          "error",
          ...mailSyntax,
          ...smsSdkSyntax,
          ...pushSyntax,
        ],
      },
    },
    {
      files: withTests(push),
      rules: {
        "no-restricted-syntax": ["error", ...mailSyntax, ...smsSyntax],
      },
    },
  ];
}
