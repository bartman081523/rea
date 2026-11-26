import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { applySurgicalNvramPatch } from "./UefiNvramPatch.js";

describe("UefiNvramPatch", () => {
  it("applies verified surgical deltas and audits differential byte count", () => {
    const original = Buffer.alloc(256, 0xff);
    original[0x10] = 0x00;
    original[0x20] = 0x01;
    original[0x30] = 0x55;

    const deltas = [
      {
        offset: 0x10,
        expectedOld: 0x00,
        newValue: 0x01,
        description: "DRD Mode Host",
      },
      {
        offset: 0x20,
        expectedOld: 0x01,
        newValue: 0x00,
        description: "SSIC Rate A",
      },
    ];

    const result = applySurgicalNvramPatch(original, deltas, {
      expectedSize: 256,
      allowedRange: { start: 0x00, end: 0x80 },
    });

    expect(result.success).toBe(true);
    expect(result.differingOffsets).toEqual([0x10, 0x20]);
    expect(result.patchedBuffer[0x10]).toBe(0x01);
    expect(result.patchedBuffer[0x20]).toBe(0x00);
    expect(result.patchedBuffer[0x30]).toBe(0x55); // untouched
    expect(result.originalSha256).not.toBe(result.patchedSha256);
  });

  it("rejects patch when pre-flight assertion fails on mismatching old byte", () => {
    const original = Buffer.alloc(256, 0);
    original[0x10] = 0xaa; // Corrupted or unexpected byte

    const deltas = [
      {
        offset: 0x10,
        expectedOld: 0x00, // Expected 0, actual is 0xaa
        newValue: 0x01,
      },
    ];

    expect(() =>
      applySurgicalNvramPatch(original, deltas, { expectedSize: 256 }),
    ).toThrow(
      /Pre-flight assertion failed at offset 0x10: actual byte 0xaa != expected 0x00/,
    );
  });

  it("rejects patch outside allowed range boundary", () => {
    const original = Buffer.alloc(256, 0);
    const deltas = [
      {
        offset: 0x90, // Outside 0..0x80
        expectedOld: 0x00,
        newValue: 0x01,
      },
    ];

    expect(() =>
      applySurgicalNvramPatch(original, deltas, {
        allowedRange: { start: 0x00, end: 0x80 },
      }),
    ).toThrow(/violates boundary constraints/);
  });

  it("rejects patch if image size differs from expectation", () => {
    const original = Buffer.alloc(128, 0);
    expect(() =>
      applySurgicalNvramPatch(original, [], { expectedSize: 256 }),
    ).toThrow(/Firmware size mismatch/);
  });
});
