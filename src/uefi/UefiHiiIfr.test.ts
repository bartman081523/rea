import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  parseHiiFormPackages,
  findQuestionsByVarStore,
  findQuestionAtOffset,
  IFR_OPCODES,
  EFI_HII_PACKAGE_TYPE_FORMS,
} from "./UefiHiiIfr.js";

describe("UefiHiiIfr", () => {
  it("parses HII form packages, varstores, forms, questions, and defaults", () => {
    // Construct synthetic HII package
    // VarStore: Opcode(0x24), Len(22 + 6 = 28)
    const varStoreName = Buffer.from("Setup\0", "ascii");
    const vsLen = 22 + varStoreName.length;
    const vs = Buffer.alloc(vsLen);
    vs[0] = IFR_OPCODES.VARSTORE;
    vs[1] = vsLen & 0x7f;
    // Guid: 16 bytes
    vs.fill(0xaa, 2, 18);
    vs.writeUInt16LE(1, 18); // VarStoreId = 1
    vs.writeUInt16LE(0x282, 20); // Size = 642
    varStoreName.copy(vs, 22);

    // Form: Opcode(0x01), Len(6)
    const form = Buffer.alloc(6);
    form[0] = IFR_OPCODES.FORM;
    form[1] = 6;
    form.writeUInt16LE(0x2762, 2); // FormId = 0x2762
    form.writeUInt16LE(100, 4); // TitleStringId = 100

    // Question 1 (ONE_OF): Opcode(0x05), Len(14)
    const q1 = Buffer.alloc(14);
    q1[0] = IFR_OPCODES.ONE_OF;
    q1[1] = 14;
    q1.writeUInt16LE(101, 2); // Prompt = 101
    q1.writeUInt16LE(102, 4); // Help = 102
    q1.writeUInt16LE(1, 6); // QuestionId = 1
    q1.writeUInt16LE(1, 8); // VarStoreId = 1
    q1.writeUInt16LE(0x01c7, 10); // VarOffset = 0x01c7 (DRD Config)
    q1[12] = 0; // Flags

    // Default for Q1: Opcode(0x09), Len(8)
    const def1 = Buffer.alloc(8);
    def1[0] = IFR_OPCODES.DEFAULT;
    def1[1] = 8;
    def1.writeUInt16LE(0x0000, 2); // DefaultId = 0 (Standard)
    def1[4] = 0; // Type uint8
    def1[6] = 0x00; // Value = 0 (DeviceMode)

    // Question 2 (CHECKBOX): Opcode(0x06), Len(14)
    const q2 = Buffer.alloc(14);
    q2[0] = IFR_OPCODES.CHECKBOX;
    q2[1] = 14;
    q2.writeUInt16LE(103, 2); // Prompt = 103
    q2.writeUInt16LE(104, 4); // Help = 104
    q2.writeUInt16LE(2, 6); // QuestionId = 2
    q2.writeUInt16LE(1, 8); // VarStoreId = 1
    q2.writeUInt16LE(0x01e1, 10); // VarOffset = 0x01e1 (SSIC HS Rate)
    q2[12] = 0;

    // Default for Q2: Opcode(0x09), Len(8)
    const def2 = Buffer.alloc(8);
    def2[0] = IFR_OPCODES.DEFAULT;
    def2[1] = 8;
    def2.writeUInt16LE(0x0000, 2);
    def2[4] = 0;
    def2[6] = 0x01; // Value = 1 (Series B)

    const payload = Buffer.concat([vs, form, q1, def1, q2, def2]);
    const pkgHeader = Buffer.alloc(4);
    const totalPkgLen = 4 + payload.length;
    pkgHeader.writeUIntLE(totalPkgLen, 0, 3);
    pkgHeader[3] = EFI_HII_PACKAGE_TYPE_FORMS;

    const fullBuffer = Buffer.concat([
      Buffer.alloc(32, 0), // Pre-padding
      pkgHeader,
      payload,
      Buffer.alloc(32, 0), // Post-padding
    ]);

    const packages = parseHiiFormPackages(fullBuffer);
    expect(packages).toHaveLength(1);

    const pkg = packages[0]!;
    expect(pkg.varStores).toHaveLength(1);
    expect(pkg.varStores[0]).toMatchObject({
      varStoreId: 1,
      name: "Setup",
      size: 0x282,
    });

    expect(pkg.forms).toHaveLength(1);
    expect(pkg.forms[0]?.formId).toBe(0x2762);

    expect(pkg.allQuestions).toHaveLength(2);

    // Test findQuestionsByVarStore
    const setupQuestions = findQuestionsByVarStore(pkg, "Setup");
    expect(setupQuestions).toHaveLength(2);

    // Test findQuestionAtOffset
    const drdQuestion = findQuestionAtOffset(pkg, "Setup", 0x01c7);
    expect(drdQuestion).toBeDefined();
    expect(drdQuestion?.opcodeName).toBe("one_of");
    expect(drdQuestion?.varOffset).toBe(0x01c7);
    expect(drdQuestion?.defaults).toHaveLength(1);
    expect(drdQuestion?.defaults[0]?.value).toBe(0x00);

    const ssicQuestion = findQuestionAtOffset(pkg, "Setup", 0x01e1);
    expect(ssicQuestion).toBeDefined();
    expect(ssicQuestion?.opcodeName).toBe("checkbox");
    expect(ssicQuestion?.defaults[0]?.value).toBe(0x01);
  });
});
