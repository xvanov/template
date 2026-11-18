import { describe, expect, it } from "@jest/globals";

import { shrinkTarget } from "./photo-files";

describe("shrinkTarget", () => {
  it("caps the long edge and keeps small photos as they are", () => {
    expect(shrinkTarget(4032, 3024)).toEqual({ width: 1568 });
    expect(shrinkTarget(3024, 4032)).toEqual({ height: 1568 });
    expect(shrinkTarget(1280, 720)).toBeNull();
    expect(shrinkTarget(1568, 1568)).toBeNull();
  });
});
