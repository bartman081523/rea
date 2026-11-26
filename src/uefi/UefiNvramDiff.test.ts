import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { diffNvramVariables } from "./UefiNvramDiff.js";
import type { AmiNvramVariable } from "./UefiNvram.js";
import type { UefiIfrPackage } from "./UefiHiiIfr.js";

const makeVar = (
  name: string,
  dataOffset: number,
  dataLength: number,
  guid: string | null = null,
): AmiNvramVariable => ({
  offset: dataOffset - 12,
  name,
  next: 0xffffff,
  attributes: 0x83, // valid
  guidIndex: 0,
  guid,
  dataOffset,
  dataLength,
  endOffset: dataOffset + dataLength,
  depth: 0,
  parentOffset: null,
});

describe("UefiNvramDiff", () => {
  it("detects added, removed, identical, and modified variables with byte deltas", () => {
    // Setup buffer A
    // Setup var: 4 bytes [0x00, 0x01, 0x02, 0x03]
    const baseBuf = Buffer.alloc(128, 0);
    const targetBuf = Buffer.alloc(128, 0);

    const setupBasePayload = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    const setupTargetPayload = Buffer.from([0x01, 0x01, 0x00, 0x03]); // offset 0: 0->1, offset 2: 2->0

    setupBasePayload.copy(baseBuf, 16);
    setupTargetPayload.copy(targetBuf, 16);

    const baseSetupVar = makeVar("Setup", 16, 4);
    const targetSetupVar = makeVar("Setup", 16, 4);

    // Identical var
    const langPayload = Buffer.from("en-US\0", "ascii");
    langPayload.copy(baseBuf, 32);
    langPayload.copy(targetBuf, 32);
    const baseLangVar = makeVar("PlatformLang", 32, langPayload.length);
    const targetLangVar = makeVar("PlatformLang", 32, langPayload.length);

    // Removed var in target (only in base)
    const oldOnlyPayload = Buffer.from([0x99]);
    oldOnlyPayload.copy(baseBuf, 48);
    const baseOldVar = makeVar("OldConfig", 48, 1);

    // Added var in target (only in target)
    const newOnlyPayload = Buffer.from([0xaa, 0xbb]);
    newOnlyPayload.copy(targetBuf, 64);
    const targetNewVar = makeVar("NewFeature", 64, 2);

    const baseVars = [baseSetupVar, baseLangVar, baseOldVar];
    const targetVars = [targetSetupVar, targetLangVar, targetNewVar];

    const mockIfrPackage: UefiIfrPackage = {
      offset: 0,
      length: 100,
      type: 2,
      varStores: [
        {
          varStoreId: 1,
          name: "Setup",
          guid: "test-guid",
          size: 64,
          offset: 0,
        },
      ],
      forms: [],
      allQuestions: [
        {
          formId: 1,
          questionId: 1,
          opcode: 5,
          opcodeName: "one_of",
          varStoreId: 1,
          varOffset: 0,
          promptStringId: 10,
          helpStringId: 11,
          flags: 0,
          defaults: [],
        },
      ],
    };

    const diff = diffNvramVariables(baseVars, targetVars, baseBuf, targetBuf, {
      ifrPackage: mockIfrPackage,
    });

    expect(diff.totalBaseCount).toBe(3);
    expect(diff.totalTargetCount).toBe(3);
    expect(diff.identicalCount).toBe(1);

    // Removed
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.name).toBe("OldConfig");

    // Added
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.name).toBe("NewFeature");

    // Modified
    expect(diff.modified).toHaveLength(1);
    const mod = diff.modified[0]!;
    expect(mod.name).toBe("Setup");
    expect(mod.diffByteCount).toBe(2);
    expect(mod.deltas).toHaveLength(2);

    // First delta at offset 0
    expect(mod.deltas[0]).toMatchObject({
      offset: 0,
      baseByte: 0x00,
      targetByte: 0x01,
    });
    // Check IFR correlation
    expect(mod.deltas[0]?.question).toBeDefined();
    expect(mod.deltas[0]?.question?.questionId).toBe(1);

    // Second delta at offset 2
    expect(mod.deltas[1]).toMatchObject({
      offset: 2,
      baseByte: 0x02,
      targetByte: 0x00,
    });
    expect(mod.deltas[1]?.question).toBeUndefined();
  });
});
