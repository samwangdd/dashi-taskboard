import { describe, expect, it } from "vitest";

import { buildTaskPrompt } from "./taskPrompt";

describe("buildTaskPrompt", () => {
  it("builds the prompt copied from an issue detail", () => {
    expect(buildTaskPrompt("WEB-42")).toBe(
      "e-taskboard Handle Taskboard issue WEB-42 and keep its progress status synchronized.",
    );
  });
});
