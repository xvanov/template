import { describe, expect, it } from "vitest";

import { verificationEmail } from "./index";

const LINK =
  "https://app.example.com/api/auth/verify-email?token=abc.def&callbackURL=%2Fapp";

describe("verificationEmail", () => {
  it("puts the link in the plain-text part, unescaped and on its own line", () => {
    const mail = verificationEmail(LINK);
    expect(mail.text).toContain(LINK);
    // A text part that only says "click the button" is useless in a text client.
    expect(mail.text.split("\n")).toContain(LINK);
  });

  it("shows the raw URL in the HTML too, not just a button", () => {
    // Link-rewriting proxies and clients that strip anchors are common enough
    // that a bare button turns into a support ticket.
    const { html } = verificationEmail(LINK);
    expect(html).toContain("Confirm email address");
    expect(html).toContain("verify-email");
  });

  it("escapes the URL into the href so a token cannot break out of the attribute", () => {
    const nasty = 'https://x.test/verify-email?token=a"onmouseover="alert(1)';
    const { html } = verificationEmail(nasty);
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("escapes the app name, which a multi-tenant caller might not control", () => {
    const { html } = verificationEmail(LINK, "<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
