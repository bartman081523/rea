import type { AmiNvramVariable } from "./UefiNvram.js";
import type { UefiIfrPackage, UefiIfrQuestion } from "./UefiHiiIfr.js";
import { findQuestionAtOffset } from "./UefiHiiIfr.js";

/**
 * Byte-level delta for a modified variable.
 */
export interface UefiNvramByteDelta {
  readonly offset: number;
  readonly baseByte: number;
  readonly targetByte: number;
  readonly question?: UefiIfrQuestion | undefined;
}

/**
 * Detailed difference record for a modified variable.
 */
export interface UefiNvramModifiedVariable {
  readonly name: string;
  readonly guid: string | null;
  readonly baseSize: number;
  readonly targetSize: number;
  readonly diffByteCount: number;
  readonly deltas: readonly UefiNvramByteDelta[];
}

/**
 * Result of comparing two NVRAM variable sets.
 */
export interface UefiNvramDiffResult {
  readonly added: readonly {
    name: string;
    guid: string | null;
    size: number;
  }[];
  readonly removed: readonly {
    name: string;
    guid: string | null;
    size: number;
  }[];
  readonly modified: readonly UefiNvramModifiedVariable[];
  readonly identicalCount: number;
  readonly totalBaseCount: number;
  readonly totalTargetCount: number;
}

/**
 * Extract the active (latest valid) variables from an AMI NVRAM list,
 * indexed by variable name (and optionally GUID).
 */
export function getActiveNvramVariables(
  variables: readonly AmiNvramVariable[],
): Map<string, AmiNvramVariable> {
  const active = new Map<string, AmiNvramVariable>();
  for (const v of variables) {
    if (v.name !== null && (v.attributes & 0x80) !== 0) {
      // Attribute 0x80 = valid in NVAR
      const key = v.guid !== null ? `${v.name}:${v.guid}` : v.name;
      active.set(key, v);
    }
  }
  return active;
}

/**
 * Perform a differential audit between two NVRAM variable sets.
 */
export function diffNvramVariables(
  baseVars: readonly AmiNvramVariable[],
  targetVars: readonly AmiNvramVariable[],
  baseBuffer: Buffer,
  targetBuffer: Buffer,
  options?: {
    readonly ifrPackage?: UefiIfrPackage;
  },
): UefiNvramDiffResult {
  const baseActive = getActiveNvramVariables(baseVars);
  const targetActive = getActiveNvramVariables(targetVars);

  const added: { name: string; guid: string | null; size: number }[] = [];
  const removed: { name: string; guid: string | null; size: number }[] = [];
  const modified: UefiNvramModifiedVariable[] = [];
  let identicalCount = 0;

  // Check all base variables
  for (const [key, baseEntry] of baseActive.entries()) {
    const targetEntry = targetActive.get(key);
    const varName = baseEntry.name ?? "unnamed";
    if (targetEntry === undefined) {
      removed.push({
        name: varName,
        guid: baseEntry.guid,
        size: baseEntry.dataLength,
      });
      continue;
    }

    const basePayload = baseBuffer.subarray(
      baseEntry.dataOffset,
      baseEntry.dataOffset + baseEntry.dataLength,
    );
    const targetPayload = targetBuffer.subarray(
      targetEntry.dataOffset,
      targetEntry.dataOffset + targetEntry.dataLength,
    );

    if (basePayload.equals(targetPayload)) {
      identicalCount++;
      continue;
    }

    // Identify byte-level deltas
    const minLen = Math.min(basePayload.length, targetPayload.length);
    const maxLen = Math.max(basePayload.length, targetPayload.length);
    const deltas: UefiNvramByteDelta[] = [];

    for (let i = 0; i < minLen; i++) {
      const bByte = basePayload[i] ?? 0;
      const tByte = targetPayload[i] ?? 0;
      if (bByte !== tByte) {
        const question =
          options?.ifrPackage !== undefined
            ? findQuestionAtOffset(options.ifrPackage, varName, i)
            : undefined;
        if (question !== undefined) {
          deltas.push({
            offset: i,
            baseByte: bByte,
            targetByte: tByte,
            question,
          });
        } else {
          deltas.push({
            offset: i,
            baseByte: bByte,
            targetByte: tByte,
          });
        }
      }
    }

    const sizeDifferenceBytes = maxLen - minLen;
    const diffByteCount = deltas.length + sizeDifferenceBytes;

    modified.push({
      name: varName,
      guid: baseEntry.guid,
      baseSize: basePayload.length,
      targetSize: targetPayload.length,
      diffByteCount,
      deltas,
    });
  }

  // Check for newly added variables
  for (const [key, targetEntry] of targetActive.entries()) {
    if (!baseActive.has(key)) {
      added.push({
        name: targetEntry.name ?? "unnamed",
        guid: targetEntry.guid,
        size: targetEntry.dataLength,
      });
    }
  }

  return {
    added,
    removed,
    modified,
    identicalCount,
    totalBaseCount: baseActive.size,
    totalTargetCount: targetActive.size,
  };
}
