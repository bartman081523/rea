import { formatGuidLittleEndian } from "./UefiGuid.js";

/**
 * UEFI HII (Human Interface Infrastructure) / IFR (Internal Form Representation)
 * parser and VarOffset cartographer.
 *
 * Implements UEFI Specification Chapter 31-33 (HII & IFR).
 * Extracts forms, questions (one_of, checkbox, numeric), VarStores, VarOffsets,
 * and factory default values from Setup.efi and other form-bearing DXE modules.
 */

export const EFI_HII_PACKAGE_TYPE_FORMS = 0x02;
export const EFI_HII_PACKAGE_TYPE_STRINGS = 0x04;

export const IFR_OPCODES = {
  FORM: 0x01,
  SUBTITLE: 0x02,
  TEXT: 0x03,
  IMAGE: 0x04,
  ONE_OF: 0x05,
  CHECKBOX: 0x06,
  NUMERIC: 0x07,
  PASSWORD: 0x08,
  DEFAULT: 0x09,
  ACTION: 0x0a,
  RESET_BUTTON: 0x0b,
  REF: 0x5c,
  VARSTORE: 0x24,
  VARSTORE_EFI: 0x26,
  VARSTORE_NAME_VALUE: 0x27,
  FORM_SET: 0x0e,
  END: 0x29,
} as const;

export type UefiIfrOpcodeName =
  | "form"
  | "one_of"
  | "checkbox"
  | "numeric"
  | "password"
  | "action"
  | "ref"
  | "reset_button"
  | "varstore"
  | "varstore_efi"
  | "default"
  | "other";

export interface UefiIfrVarStore {
  readonly varStoreId: number;
  readonly guid: string | null;
  readonly name: string;
  readonly size: number;
  readonly offset: number;
}

export interface UefiIfrDefault {
  readonly defaultId: number;
  readonly type: number;
  readonly value: number;
  readonly isStandardDefault: boolean;
  readonly isManufacturingDefault: boolean;
}

export interface UefiIfrQuestion {
  readonly formId: number | null;
  readonly questionId: number;
  readonly opcode: number;
  readonly opcodeName: UefiIfrOpcodeName;
  readonly varStoreId: number;
  readonly varOffset: number;
  readonly promptStringId: number;
  readonly helpStringId: number;
  readonly flags: number;
  readonly defaults: readonly UefiIfrDefault[];
}

export interface UefiIfrForm {
  readonly formId: number;
  readonly titleStringId: number;
  readonly questions: readonly UefiIfrQuestion[];
}

export interface UefiIfrPackage {
  readonly offset: number;
  readonly length: number;
  readonly type: number;
  readonly varStores: readonly UefiIfrVarStore[];
  readonly forms: readonly UefiIfrForm[];
  readonly allQuestions: readonly UefiIfrQuestion[];
}

/**
 * Scan a binary buffer (e.g. Setup.efi or extracted DXE section) for HII Form Packages.
 */
export function parseHiiFormPackages(data: Buffer): UefiIfrPackage[] {
  const packages: UefiIfrPackage[] = [];
  const len = data.length;

  for (let offset = 0; offset + 4 <= len; offset++) {
    // Check for HII package header: 24-bit length + 8-bit type
    const pkgType = data[offset + 3];
    if (pkgType !== EFI_HII_PACKAGE_TYPE_FORMS) {
      continue;
    }

    const b0 = data[offset] ?? 0;
    const b1 = data[offset + 1] ?? 0;
    const b2 = data[offset + 2] ?? 0;
    const pkgLen = b0 | (b1 << 8) | (b2 << 16);
    if (pkgLen < 8 || offset + pkgLen > len) {
      continue;
    }

    // Attempt parsing as Form Package
    const parsed = parseSingleFormPackage(data, offset, pkgLen);
    if (parsed.varStores.length > 0 || parsed.forms.length > 0) {
      packages.push(parsed);
      offset += pkgLen - 1; // Advance past this package
    }
  }

  return packages;
}

function parseSingleFormPackage(
  data: Buffer,
  packageOffset: number,
  packageLength: number,
): UefiIfrPackage {
  const varStores: UefiIfrVarStore[] = [];
  const forms: UefiIfrForm[] = [];
  const allQuestions: UefiIfrQuestion[] = [];

  let ptr = packageOffset + 4;
  const end = packageOffset + packageLength;

  let currentFormId: number | null = null;
  let currentFormTitleStringId = 0;
  let currentFormQuestions: UefiIfrQuestion[] = [];
  let currentQuestion: {
    formId: number | null;
    questionId: number;
    opcode: number;
    opcodeName: UefiIfrOpcodeName;
    varStoreId: number;
    varOffset: number;
    promptStringId: number;
    helpStringId: number;
    flags: number;
    defaults: UefiIfrDefault[];
  } | null = null;

  function commitCurrentQuestion() {
    if (currentQuestion !== null) {
      const q: UefiIfrQuestion = {
        ...currentQuestion,
        defaults: [...currentQuestion.defaults],
      };
      currentFormQuestions.push(q);
      allQuestions.push(q);
      currentQuestion = null;
    }
  }

  function commitCurrentForm() {
    commitCurrentQuestion();
    if (currentFormId !== null) {
      forms.push({
        formId: currentFormId,
        titleStringId: currentFormTitleStringId,
        questions: [...currentFormQuestions],
      });
      currentFormId = null;
      currentFormTitleStringId = 0;
      currentFormQuestions = [];
    }
  }

  while (ptr + 2 <= end) {
    const opcode = data[ptr] ?? 0;
    const headerByte = data[ptr + 1] ?? 0;
    const opLen = headerByte & 0x7f;

    if (opLen < 2 || ptr + opLen > end) {
      break;
    }

    switch (opcode) {
      case IFR_OPCODES.VARSTORE: {
        // VarStore Op: Opcode(1) + Len(1) + Guid(16) + VarStoreId(2) + Size(2) + Name(null-term ascii)
        if (opLen >= 22) {
          const guid = formatGuidLittleEndian(data, ptr + 2);
          const varStoreId = data.readUInt16LE(ptr + 18);
          const size = data.readUInt16LE(ptr + 20);
          const nameEnd = data.indexOf(0, ptr + 22);
          const name =
            nameEnd !== -1 && nameEnd < ptr + opLen
              ? data.toString("ascii", ptr + 22, nameEnd)
              : "";
          varStores.push({
            varStoreId,
            guid,
            name,
            size,
            offset: ptr,
          });
        }
        break;
      }

      case IFR_OPCODES.VARSTORE_EFI: {
        // VarStore EFI Op: Opcode(1) + Len(1) + VarStoreId(2) + Guid(16) + Attributes(4) + Size(2) + Name
        if (opLen >= 26) {
          const varStoreId = data.readUInt16LE(ptr + 2);
          const guid = formatGuidLittleEndian(data, ptr + 4);
          const size = data.readUInt16LE(ptr + 24);
          const nameEnd = data.indexOf(0, ptr + 26);
          const name =
            nameEnd !== -1 && nameEnd < ptr + opLen
              ? data.toString("ascii", ptr + 26, nameEnd)
              : "";
          varStores.push({
            varStoreId,
            guid,
            name,
            size,
            offset: ptr,
          });
        }
        break;
      }

      case IFR_OPCODES.FORM: {
        commitCurrentForm();
        if (opLen >= 6) {
          currentFormId = data.readUInt16LE(ptr + 2);
          currentFormTitleStringId = data.readUInt16LE(ptr + 4);
        }
        break;
      }

      case IFR_OPCODES.ONE_OF:
      case IFR_OPCODES.CHECKBOX:
      case IFR_OPCODES.NUMERIC:
      case IFR_OPCODES.PASSWORD:
      case IFR_OPCODES.ACTION:
      case IFR_OPCODES.REF: {
        commitCurrentQuestion();
        // Standard question header starts at ptr + 2:
        // Prompt(2) + Help(2) + QuestionId(2) + VarStoreId(2) + VarOffset(2) + Flags(1)
        if (opLen >= 12) {
          const promptStringId = data.readUInt16LE(ptr + 2);
          const helpStringId = data.readUInt16LE(ptr + 4);
          const questionId = data.readUInt16LE(ptr + 6);
          const varStoreId = data.readUInt16LE(ptr + 8);
          const varOffset = data.readUInt16LE(ptr + 10);
          const flags = data[ptr + 12] ?? 0;

          const opcodeName: UefiIfrOpcodeName =
            opcode === IFR_OPCODES.ONE_OF
              ? "one_of"
              : opcode === IFR_OPCODES.CHECKBOX
                ? "checkbox"
                : opcode === IFR_OPCODES.NUMERIC
                  ? "numeric"
                  : opcode === IFR_OPCODES.PASSWORD
                    ? "password"
                    : opcode === IFR_OPCODES.ACTION
                      ? "action"
                      : "ref";

          currentQuestion = {
            formId: currentFormId,
            questionId,
            opcode,
            opcodeName,
            varStoreId,
            varOffset,
            promptStringId,
            helpStringId,
            flags,
            defaults: [],
          };
        }
        break;
      }

      case IFR_OPCODES.DEFAULT: {
        if (currentQuestion !== null && opLen >= 7) {
          const defaultId = data.readUInt16LE(ptr + 2);
          const type = data[ptr + 4] ?? 0;
          const val = data[ptr + 6] ?? 0;
          const isStandardDefault = defaultId === 0x0000;
          const isManufacturingDefault = defaultId === 0x0001;

          currentQuestion.defaults.push({
            defaultId,
            type,
            value: val,
            isStandardDefault,
            isManufacturingDefault,
          });
        }
        break;
      }

      default:
        break;
    }

    ptr += opLen;
  }

  commitCurrentForm();

  return {
    offset: packageOffset,
    length: packageLength,
    type: EFI_HII_PACKAGE_TYPE_FORMS,
    varStores,
    forms,
    allQuestions,
  };
}

/**
 * Locate all questions associated with a given VarStore name or VarStore ID.
 */
export function findQuestionsByVarStore(
  pkg: UefiIfrPackage,
  varStoreNameOrId: string | number,
): UefiIfrQuestion[] {
  let targetId: number | null = null;
  if (typeof varStoreNameOrId === "number") {
    targetId = varStoreNameOrId;
  } else {
    const store = pkg.varStores.find((s) => s.name === varStoreNameOrId);
    if (store !== undefined) {
      targetId = store.varStoreId;
    }
  }

  if (targetId === null) {
    return [];
  }

  return pkg.allQuestions.filter((q) => q.varStoreId === targetId);
}

/**
 * Locate a specific question by VarStore and VarOffset.
 */
export function findQuestionAtOffset(
  pkg: UefiIfrPackage,
  varStoreNameOrId: string | number,
  varOffset: number,
): UefiIfrQuestion | undefined {
  const matches = findQuestionsByVarStore(pkg, varStoreNameOrId);
  return matches.find((q) => q.varOffset === varOffset);
}
