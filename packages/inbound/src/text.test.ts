import { describe, expect, it } from "vitest";

import { plainEmail, withoutPlusTag } from "./routing";
import { cleanFilename, htmlToText, messageIds, outboundIdsIn } from "./text";

describe("htmlToText", () => {
  it("keeps the words and line breaks, drops markup, scripts and styles", () => {
    expect(
      htmlToText(
        "<style>p{color:red}</style><p>Hi &amp; welcome</p><ul><li>one</li><li>two</li></ul><script>alert(1)</script>&lt;b&gt;",
      ),
    ).toBe("Hi & welcome\n• one\n• two\n<b>");
  });

  it("decodes entities once (no double-decoding into markup)", () => {
    expect(htmlToText("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(htmlToText("&#65;&#x42;&#0;")).toBe("AB");
  });
});

describe("threading ids", () => {
  it("collects every <id> from In-Reply-To and References", () => {
    expect(messageIds("<a@x>", ["<b@y> <c@z>", "<a@x>"], null)).toEqual([
      "<a@x>",
      "<b@y>",
      "<c@z>",
    ]);
  });

  it("recognises only our own Message-IDs as outbound row ids", () => {
    expect(
      outboundIdsIn([
        "<obm.cmabc1234567@app.test>",
        "<obm.x@app.test>",
        "<cmabc1234567@other>",
      ]),
    ).toEqual(["cmabc1234567"]);
  });
});

describe("addresses and filenames", () => {
  it("parses one address, with or without a display name", () => {
    expect(plainEmail("Jane <Jane@Example.TEST>")).toBe("jane@example.test");
    expect(plainEmail("a@b.test, c@d.test")).toBeNull();
  });

  it("strips a plus tag for routing", () => {
    expect(withoutPlusTag("acme-k3x9+billing@in.test")).toBe(
      "acme-k3x9@in.test",
    );
    expect(withoutPlusTag("acme@in.test")).toBe("acme@in.test");
  });

  it("cleans filenames of paths and control characters", () => {
    expect(cleanFilename("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanFilename("a\u0000b.pdf")).toBe("ab.pdf");
    expect(cleanFilename("")).toBe("attachment");
  });
});
