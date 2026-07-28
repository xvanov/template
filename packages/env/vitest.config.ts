import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // No shared setup here on purpose: these tests assert what happens when the
    // required variables are ABSENT, so they must own process.env themselves.
  },
});
