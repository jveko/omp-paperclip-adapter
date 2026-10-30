import { describe, expect, it } from "vitest";
import { validThinkingLevel, validThinkingSuffix } from "./thinking-levels.js";

describe("validThinkingLevel (run directive)", () => {
  it.each(["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "accepts the CLI level %s",
    (level) => {
      expect(validThinkingLevel(level)).toBe(level);
    },
  );

  it("trims padded values", () => {
    expect(validThinkingLevel(" medium ")).toBe("medium");
  });

  it("rejects abbreviations: the --thinking flag takes the spelled level", () => {
    expect(validThinkingLevel("med")).toBeNull();
  });

  it("rejects non-string and empty values", () => {
    expect(validThinkingLevel(undefined)).toBeNull();
    expect(validThinkingLevel(5)).toBeNull();
    expect(validThinkingLevel("")).toBeNull();
  });
});

describe("validThinkingSuffix (model role value)", () => {
  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "accepts the selector suffix %s",
    (level) => {
      expect(validThinkingSuffix(level)).toBe(level);
    },
  );

  it("rejects auto: omp's resolver does not accept :auto on a model pattern", () => {
    expect(validThinkingSuffix("auto")).toBeNull();
    expect(validThinkingSuffix("au")).toBeNull();
  });

  it("accepts unambiguous abbreviations like omp's selector parser", () => {
    expect(validThinkingSuffix("med")).toBe("medium");
    expect(validThinkingSuffix("xhi")).toBe("xhigh");
    expect(validThinkingSuffix("max")).toBe("max");
  });

  it("rejects a one-character or ambiguous abbreviation and unknown words", () => {
    expect(validThinkingSuffix("m")).toBeNull();
    expect(validThinkingSuffix("bogus")).toBeNull();
  });
});
