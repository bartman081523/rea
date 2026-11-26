import { sha256Hex } from "../kernel/sha256Hex.js";

/**
 * Single surgical patch directive.
 */
export interface UefiNvramPatchDelta {
  readonly offset: number;
  readonly expectedOld: number;
  readonly newValue: number;
  readonly description?: string;
}

/**
 * Result of applying and verifying an NVRAM patch plan.
 */
export interface UefiNvramPatchResult {
  readonly success: boolean;
  readonly originalSha256: string;
  readonly patchedSha256: string;
  readonly patchedBuffer: Buffer;
  readonly appliedDeltas: readonly UefiNvramPatchDelta[];
  readonly differingOffsets: readonly number[];
}

export interface UefiNvramPatchOptions {
  /** Enforce strict boundaries (e.g. must be inside NVRAM volume) */
  readonly allowedRange?: { readonly start: number; readonly end: number };
  /** Expected total image size */
  readonly expectedSize?: number;
  /** Expected original SHA-256 */
  readonly expectedSha256?: string;
}

/**
 * Apply surgical BIOS patches with strict pre-flight assertions and differential audits.
 *
 * Implements the epistemic firmware repair invariants:
 * 1. File size strictly preserved.
 * 2. Pre-flight assertion: original bytes must match expectedOld exactly.
 * 3. Scope assertion: modified bytes must fall strictly within allowed boundaries.
 * 4. Post-flight differential: exact differing byte count must equal requested delta count.
 */
export function applySurgicalNvramPatch(
  sourceBuffer: Buffer,
  deltas: readonly UefiNvramPatchDelta[],
  options?: UefiNvramPatchOptions,
): UefiNvramPatchResult {
  if (
    options?.expectedSize !== undefined &&
    sourceBuffer.length !== options.expectedSize
  ) {
    throw new Error(
      `Firmware size mismatch: actual ${sourceBuffer.length} bytes, expected ${options.expectedSize} bytes`,
    );
  }

  const originalSha256 = sha256Hex(sourceBuffer);
  if (
    options?.expectedSha256 !== undefined &&
    originalSha256 !== options.expectedSha256
  ) {
    throw new Error(
      `Source firmware SHA-256 mismatch: actual ${originalSha256}, expected ${options.expectedSha256}`,
    );
  }

  // Pre-flight check: verify all targets before modifying anything
  for (const delta of deltas) {
    if (delta.offset < 0 || delta.offset >= sourceBuffer.length) {
      throw new RangeError(
        `Patch offset 0x${delta.offset.toString(16)} is out of image bounds (0..${sourceBuffer.length})`,
      );
    }

    if (options?.allowedRange !== undefined) {
      if (
        delta.offset < options.allowedRange.start ||
        delta.offset >= options.allowedRange.end
      ) {
        throw new Error(
          `Patch offset 0x${delta.offset.toString(16)} violates boundary constraints [0x${options.allowedRange.start.toString(16)}..0x${options.allowedRange.end.toString(16)})`,
        );
      }
    }

    const actualOld = sourceBuffer[delta.offset];
    if (actualOld !== delta.expectedOld) {
      throw new Error(
        `Pre-flight assertion failed at offset 0x${delta.offset.toString(16)}: actual byte 0x${actualOld?.toString(16).padStart(2, "0")} != expected 0x${delta.expectedOld.toString(16).padStart(2, "0")} (${delta.description ?? "no desc"})`,
      );
    }
  }

  // Apply mutations on a copy
  const patched = Buffer.from(sourceBuffer);
  for (const delta of deltas) {
    patched[delta.offset] = delta.newValue;
  }

  // Differential audit across the full image
  const differingOffsets: number[] = [];
  for (let i = 0; i < sourceBuffer.length; i++) {
    if (sourceBuffer[i] !== patched[i]) {
      differingOffsets.push(i);
    }
  }

  if (differingOffsets.length !== deltas.length) {
    throw new Error(
      `Post-flight differential mismatch: expected ${deltas.length} changed bytes, detected ${differingOffsets.length} differing bytes`,
    );
  }

  const patchedSha256 = sha256Hex(patched);

  return {
    success: true,
    originalSha256,
    patchedSha256,
    patchedBuffer: patched,
    appliedDeltas: deltas,
    differingOffsets,
  };
}
