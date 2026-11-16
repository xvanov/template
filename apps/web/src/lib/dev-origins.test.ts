import { describe, expect, it } from "vitest";

import { devOriginHosts } from "./dev-origins";

describe("devOriginHosts", () => {
  it("takes the hostname of APP_URL and every trusted origin", () => {
    expect(
      devOriginHosts({
        APP_URL: "https://box.tail1234.ts.net:8443",
        TRUSTED_ORIGINS: " http://100.64.0.7:3200 ,http://192.168.1.20:8092",
      }),
    ).toEqual(["box.tail1234.ts.net", "100.64.0.7", "192.168.1.20"]);
  });

  it("dedupes, and skips blanks and malformed entries instead of throwing", () => {
    expect(
      devOriginHosts({
        APP_URL: "http://localhost:3200",
        TRUSTED_ORIGINS: "http://localhost:8092,,not a url,",
      }),
    ).toEqual(["localhost"]);
  });

  it("is empty when nothing is configured", () => {
    expect(devOriginHosts({})).toEqual([]);
  });
});
