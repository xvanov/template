/**
 * Import boundaries that every workspace must respect, as ESLint rules so a
 * violation is a red squiggle in the editor and a failed `make lint`, not a
 * surprise in review.
 *
 * Every outbound message goes through the outbound guard (docs/guide.md rule 8),
 * so each provider is reachable from exactly one file, its channel's transport:
 *   mail  nodemailer / resend / ...      packages/email/src/transport.ts
 *         (and RESEND_API_KEY)
 *   push  the ntfy URL and token         packages/notify/src/ntfy.ts
 *   sms   the Twilio API host            packages/sms/src/transport.ts // @module:sms
 *         (and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN; that file is a small // @module:sms
 *         fetch client, and SMS SDKs such as `twilio` are refused everywhere) // @module:sms
 *   mobile_push  the Expo push host       packages/push-mobile/src/transport.ts // @module:push-mobile
 *         (and EXPO_ACCESS_TOKEN; a fetch client, no SDK) // @module:push-mobile
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
const MAIL_MESSAGE =
  "Outbound messages go through the guard: use sendMail from @repo/email (docs/guide.md rule 8). Only packages/email/src/transport.ts may import a mail library.";
const MAIL_RE =
  "/^(nodemailer|@sendgrid\\u002F|resend$|postmark$|mailgun|@aws-sdk\\u002Fclient-ses)/";

const NTFY_MESSAGE =
  "Pushes go through the guard: use notifyOperator from @repo/notify (docs/guide.md rule 8). Only packages/notify/src/ntfy.ts may read NTFY_URL / NTFY_TOKEN.";
const NTFY_RE = "/^NTFY_(URL|TOKEN)$/";
const RESEND_KEY_MESSAGE =
  "Only packages/email/src/transport.ts may read RESEND_API_KEY (docs/guide.md rule 8).";
const RESEND_KEY_RE = "/^RESEND_API_KEY$/";
// @module:sms
// A regex, not a gitignore-style group: "twilio/*" would also match a local
// "./twilio/route" import (the webhook's own folder).
const SMS_SDKS_REGEX =
  "^(twilio|vonage|messagebird|plivo|telnyx)(/.*)?$|^@vonage/";
const SMS_MESSAGE =
  "Outbound messages go through the guard: use sendSms from @repo/sms (docs/guide.md rule 8). SMS SDKs are not used at all: packages/sms/src/transport.ts is the (fetch) client.";
const SMS_RE = "/^(twilio|@vonage\\u002F|vonage$|messagebird$|plivo$|telnyx$)/";
const TWILIO_KEY_MESSAGE =
  "Only packages/sms/src/transport.ts may read TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (docs/guide.md rule 8).";
const TWILIO_KEY_RE = "/^TWILIO_(ACCOUNT_SID|AUTH_TOKEN)$/";
const TWILIO_HOST_MESSAGE =
  "Only packages/sms/src/transport.ts may call the Twilio API (docs/guide.md rule 8): use sendSms from @repo/sms.";
const TWILIO_HOST_RE = "/api\\.twilio\\.com/i";
// @end

// @module:push-mobile
const EXPO_PUSH_MESSAGE =
  "Mobile pushes go through the guard: use sendMobilePush from @repo/push-mobile (docs/guide.md rule 8). Only packages/push-mobile/src/transport.ts may call the Expo push service or read EXPO_ACCESS_TOKEN.";
const EXPO_KEY_RE = "/^EXPO_ACCESS_TOKEN$/";
const EXPO_HOST_RE = "/exp\\.host/i";
// The server SDK is refused everywhere (the transport is a fetch client).
const EXPO_SDK_RE = "/^expo-server-sdk$/";
// @end

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
const pushSyntax = reads(NTFY_RE, NTFY_MESSAGE);
const mailImports = { group: MAIL_SDKS, message: MAIL_MESSAGE };

// @module:sms
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
const smsImports = { regex: SMS_SDKS_REGEX, message: SMS_MESSAGE };
// @end

// @module:push-mobile
const expoSdkSyntax = dynamicImport(EXPO_SDK_RE, EXPO_PUSH_MESSAGE);
const mobilePushSyntax = [
  ...expoSdkSyntax,
  ...reads(EXPO_KEY_RE, EXPO_PUSH_MESSAGE),
  { selector: `Literal[value=${EXPO_HOST_RE}]`, message: EXPO_PUSH_MESSAGE },
  {
    selector: `TemplateElement[value.raw=${EXPO_HOST_RE}]`,
    message: EXPO_PUSH_MESSAGE,
  },
];
const expoImports = { group: ["expo-server-sdk"], message: EXPO_PUSH_MESSAGE };
// @end

/** Every channel's restricted imports and syntax, by channel. */
const IMPORTS = {
  mail: mailImports,
  sms: smsImports, // @module:sms
  mobilePush: expoImports, // @module:push-mobile
};
const SYNTAX = {
  mail: mailSyntax,
  push: pushSyntax,
  sms: smsSyntax, // @module:sms
  mobilePush: mobilePushSyntax, // @module:push-mobile
};
/** The imports / syntax of every channel except `skip`. */
const importsExcept = (...skip) =>
  Object.entries(IMPORTS)
    .filter(([k]) => !skip.includes(k))
    .map(([, v]) => v);
const syntaxExcept = (...skip) =>
  Object.entries(SYNTAX)
    .filter(([k]) => !skip.includes(k))
    .flatMap(([, v]) => v);

/** A transport and its own tests (which point it at a fake). */
const withTests = (file) => [file, file.replace(/\.ts$/, ".test.ts")];

/**
 * @param {Record<string, string>} transports  the one file allowed to reach
 *   each provider (mail, push, sms, mobilePush), relative to the config's
 *   directory ("__none__" = none)
 */
export function outboundBoundary(transports) {
  return [
    {
      files: ["**/*.{ts,tsx,js,mjs,cjs,jsx}"],
      rules: {
        "no-restricted-imports": ["error", { patterns: importsExcept() }],
        "no-restricted-syntax": ["error", ...syntaxExcept()],
      },
    },
    {
      files: withTests(transports.mail),
      rules: {
        "no-restricted-imports": ["error", { patterns: importsExcept("mail") }],
        "no-restricted-syntax": ["error", ...syntaxExcept("mail")],
      },
    },
    {
      files: withTests(transports.push),
      rules: { "no-restricted-syntax": ["error", ...syntaxExcept("push")] },
    },
    // @module:sms
    {
      // The sms transport (the SDK stays refused here too); its tests live
      // next to the package entry point.
      files: [
        transports.sms,
        transports.sms.replace(/transport\.ts$/, "index.test.ts"),
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [mailImports, smsImports] },
        ],
        "no-restricted-syntax": [
          "error",
          ...syntaxExcept("sms"),
          ...smsSdkSyntax,
        ],
      },
    },
    // @end
    // @module:push-mobile
    {
      // The Expo push transport (the SDK stays refused); its tests live next
      // to the package entry point.
      files: [
        transports.mobilePush,
        transports.mobilePush.replace(/transport\.ts$/, "index.test.ts"),
      ],
      rules: {
        "no-restricted-syntax": [
          "error",
          ...syntaxExcept("mobilePush"),
          ...expoSdkSyntax,
        ],
      },
    },
    // @end
  ];
}
