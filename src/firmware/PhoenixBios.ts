/**
 * Phoenix TrustedCore / PhoenixBIOS 4.0 Release 6.x ROM Architecture Parser
 * Handles legacy Phoenix BIOS containers, BCP tables, and compressed modules (_Axx, _Bxx, _Mxx, _Qxx, etc.).
 */

export interface PhoenixBcpModule {
  signature: string;
  offset: number;
  length: number;
}

export interface PhoenixModuleDescriptor {
  name: string;
  classType: string;
  tagOffset: number;
  streamOffset: number;
  compressedSize: number;
  decompressedSize: number;
  isOptionRom: boolean;
}

export interface PhoenixBiosReport {
  fileSize: number;
  bcpTableOffset: number;
  systemInfoOffset: number;
  version: string;
  releaseDate?: string | undefined;
  bcpModules: PhoenixBcpModule[];
  modules: PhoenixModuleDescriptor[];
  resetVector: {
    offset: number;
    jumpTarget: string;
    rawBytes: string;
  };
}

export class PhoenixBiosParser {
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  public parse(): PhoenixBiosReport {
    if (this.buffer.length < 0x20000) {
      throw new Error(
        `Invalid Phoenix BIOS size: ${this.buffer.length} bytes (expected >= 128KB)`,
      );
    }

    const bcpTableOffset = this.findBcpTable();
    const systemInfoOffset = this.findBcpSignature("BCPSYS");
    const version = this.extractVersion(systemInfoOffset);
    const releaseDate = this.extractReleaseDate(systemInfoOffset);
    const bcpModules = this.scanBcpModules();
    const modules = this.scanModules();
    const resetVector = this.extractResetVector();

    return {
      fileSize: this.buffer.length,
      bcpTableOffset,
      systemInfoOffset,
      version,
      releaseDate,
      bcpModules,
      modules,
      resetVector,
    };
  }

  private findBcpTable(): number {
    const sig = Buffer.from("BCPSEGMENT", "ascii");
    const idx = this.buffer.indexOf(sig);
    return idx !== -1 ? idx : 0;
  }

  private findBcpSignature(name: string): number {
    const sig = Buffer.from(name, "ascii");
    const idx = this.buffer.indexOf(sig);
    return idx !== -1 ? idx : 0;
  }

  private extractVersion(sysOffset: number): string {
    if (sysOffset <= 0 || sysOffset + 0x40 > this.buffer.length) {
      return "UNKNOWN";
    }
    const raw = this.buffer.subarray(sysOffset + 0x37, sysOffset + 0x3f);
    return raw
      .toString("ascii")
      .replace(/[^\x20-\x7E]/g, "")
      .trim();
  }

  private extractReleaseDate(sysOffset: number): string | undefined {
    if (sysOffset <= 0 || sysOffset + 0x30 > this.buffer.length) {
      return undefined;
    }
    const raw = this.buffer.subarray(sysOffset + 15, sysOffset + 25);
    const str = raw
      .toString("ascii")
      .replace(/[^\x20-\x7E]/g, "")
      .trim();
    return str.length > 0 ? str : undefined;
  }

  private scanBcpModules(): PhoenixBcpModule[] {
    const results: PhoenixBcpModule[] = [];
    const pattern = /BCP[A-Z0-9_]{3,8}/g;
    const str = this.buffer.toString("latin1");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(str)) !== null) {
      const offset = match.index;
      const sig = match[0];
      // In BCP table, length is usually at offset + sig.length + 2
      const lenOffset = offset + sig.length + 2;
      let len = 0;
      if (lenOffset + 2 <= this.buffer.length) {
        len = this.buffer.readUInt16LE(lenOffset);
      }
      results.push({ signature: sig, offset, length: len });
    }

    return results;
  }

  public scanModules(): PhoenixModuleDescriptor[] {
    const modules: PhoenixModuleDescriptor[] = [];
    const buf = this.buffer;
    const pattern = /(_[A-Z0-9]{3})\x00\x00\x00\x00/g;
    const text = buf.toString("latin1");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const tagOffset = match.index;
      const name = match[1] ?? "";

      // Option ROMs (_Bxx) have an 8-byte PCI ID before the sizes
      const isOptionRom = name.startsWith("_B");
      const sizeOffset = isOptionRom ? tagOffset + 28 : tagOffset + 20;

      if (sizeOffset + 8 > buf.length) {
        continue;
      }

      const compSize = buf.readUInt32LE(sizeOffset);
      const decompSize = buf.readUInt32LE(sizeOffset + 4);
      const streamOffset = isOptionRom ? tagOffset + 36 : tagOffset + 28;

      if (
        compSize > 0 &&
        compSize < buf.length &&
        decompSize > 0 &&
        decompSize < 0x200000 &&
        streamOffset + compSize <= buf.length
      ) {
        modules.push({
          name,
          classType: this.classifyModuleName(name),
          tagOffset,
          streamOffset,
          compressedSize: compSize,
          decompressedSize: decompSize,
          isOptionRom,
        });
      }
    }

    return modules;
  }

  private classifyModuleName(name: string): string {
    const prefix = name.substring(1, 2);
    switch (prefix) {
      case "A":
        return "ACPI_TABLE";
      case "B":
        return "OPTION_ROM";
      case "C":
        return "SETUP_CORE";
      case "D":
        return "DMI_SMBIOS";
      case "E":
        return "EXTENDED_SETUP";
      case "H":
        return "STORAGE_HDD";
      case "K":
        return "KERNEL_CORE";
      case "L":
        return "LANGUAGE_STRINGS";
      case "M":
        return "CPU_MICROCODE";
      case "Q":
        return "ACPI_LOADER";
      case "R":
        return "EXPANSION_ROM";
      case "S":
        return "SYSTEM_POST";
      case "T":
        return "TIMER_POWER";
      case "X":
        return "EXTENDED_CODE";
      default:
        return "UNKNOWN";
    }
  }

  private extractResetVector(): {
    offset: number;
    jumpTarget: string;
    rawBytes: string;
  } {
    const resetOffset = this.buffer.length - 16;
    const raw = this.buffer.subarray(resetOffset, resetOffset + 16);
    let target = "UNKNOWN";

    if (raw[0] === 0xe9) {
      // Relative 16-bit jump
      const rel = raw.readInt16LE(1);
      const abs = (0xfff0 + 3 + rel) & 0xffff;
      target = `F000:${abs.toString(16).toUpperCase().padStart(4, "0")}`;
    } else if (raw[0] === 0xea) {
      // Far jump JMP ptr16:16
      const off = raw.readUInt16LE(1);
      const seg = raw.readUInt16LE(3);
      target = `${seg.toString(16).toUpperCase().padStart(4, "0")}:${off.toString(16).toUpperCase().padStart(4, "0")}`;
    }

    return {
      offset: resetOffset,
      jumpTarget: target,
      rawBytes: raw.toString("hex"),
    };
  }
}

/**
 * Pure LZHUF Decompressor for Phoenix BIOS Modules (13-bit dictionary, 8-bit threshold).
 */
export class PhoenixLzhDecompressor {
  public static decompress(packed: Buffer, uncompressedSize: number): Buffer {
    const out = Buffer.alloc(uncompressedSize);
    let inPos = 0;
    let outPos = 0;

    let bitBuf = 0;
    let bitCount = 0;

    function getBits(n: number): number {
      while (bitCount < n) {
        const b = inPos < packed.length ? (packed[inPos++] ?? 0) : 0;
        bitBuf = (bitBuf << 8) | b;
        bitCount += 8;
      }
      bitCount -= n;
      return (bitBuf >>> bitCount) & ((1 << n) - 1);
    }

    // Circular dictionary
    const DIC_SIZE = 8192;
    const dic = new Uint8Array(DIC_SIZE);
    let dicPos = 0;

    // Decode loop
    while (outPos < uncompressedSize && inPos <= packed.length + 4) {
      const flag = getBits(1);
      if (flag === 1) {
        // Direct literal byte
        const char = getBits(8);
        dic[dicPos] = char;
        dicPos = (dicPos + 1) % DIC_SIZE;
        out[outPos++] = char;
      } else {
        // Match offset and length
        const offset = getBits(13);
        const matchLen = getBits(4) + 3; // Threshold = 3

        for (let i = 0; i < matchLen && outPos < uncompressedSize; i++) {
          const char = dic[(offset + i) % DIC_SIZE] ?? 0;
          dic[dicPos] = char;
          dicPos = (dicPos + 1) % DIC_SIZE;
          out[outPos++] = char;
        }
      }
    }

    return out;
  }
}

/**
 * ACPI DSDT/SSDT Patcher for Phoenix BIOS.
 * Handles surgical AML patching and ACPI table checksum reconciliation.
 */
export class PhoenixAcpiPatcher {
  /**
   * Patches the legacy Phoenix BIOS DSDT bug where PEGC and PEGD PCI Routing Tables
   * reference non-existent \_SB_.PCI0.LNKH instead of rotating through LNKA, LNKB, LNKC, LNKD.
   */
  public static patchDsdtLnkH(
    dsdtBuffer: Buffer,
    bumpOemRevision = true,
  ): {
    patched: Buffer;
    replacements: number;
    originalChecksum: number;
    newChecksum: number;
    oldOemRevision: number;
    newOemRevision: number;
  } {
    // If table has a 4-byte header prefix (e.g. from Phoenix module container), find DSDT start
    let tableOffset = 0;
    if (dsdtBuffer.readUInt32BE(0) !== 0x44534454) {
      // 'DSDT'
      const idx = dsdtBuffer.indexOf(Buffer.from("DSDT", "ascii"));
      if (idx !== -1) {
        tableOffset = idx;
      }
    }

    const patched = Buffer.from(dsdtBuffer);
    const originalChecksum = patched[tableOffset + 9] ?? 0;
    const oldOemRevision = patched.readUInt32LE(tableOffset + 24);
    const newOemRevision = bumpOemRevision
      ? oldOemRevision + 1
      : oldOemRevision;
    if (bumpOemRevision) {
      patched.writeUInt32LE(newOemRevision, tableOffset + 24);
    }

    // Pattern for \_SB_.PCI0.LNKH in AML:
    // 5c 2f 03 5f 53 42 5f 50 43 49 30 4c 4e 4b 48
    const pattern = Buffer.from([
      0x5c, 0x2f, 0x03, 0x5f, 0x53, 0x42, 0x5f, 0x50, 0x43, 0x49, 0x30, 0x4c,
      0x4e, 0x4b, 0x48,
    ]);

    const targetPins = [0x41, 0x42, 0x43, 0x44]; // 'A', 'B', 'C', 'D'
    let replacements = 0;
    let searchPos = tableOffset;

    while (true) {
      const found = patched.indexOf(pattern, searchPos);
      if (found === -1) {
        break;
      }

      // Pin index within 4-entry routing group (0..3)
      const pinIndex = replacements % 4;
      const newPinByte = targetPins[pinIndex] ?? 0x41;

      // Replace last byte 'H' (0x48) with LNKA, LNKB, LNKC, or LNKD
      patched[found + pattern.length - 1] = newPinByte;
      replacements++;
      searchPos = found + pattern.length;
    }

    // Recompute ACPI checksum at tableOffset + 9
    const tableLength = patched.readUInt32LE(tableOffset + 4);
    let sum = 0;
    for (let i = 0; i < tableLength; i++) {
      if (i !== 9) {
        sum = (sum + (patched[tableOffset + i] ?? 0)) & 0xff;
      }
    }
    const newChecksum = (0x100 - sum) & 0xff;
    patched[tableOffset + 9] = newChecksum;

    return {
      patched,
      replacements,
      originalChecksum,
      newChecksum,
      oldOemRevision,
      newOemRevision,
    };
  }

  /**
   * Verifies that the ACPI table checksum byte matches the sum-to-zero rule.
   */
  public static verifyChecksum(table: Buffer, tableOffset = 0): boolean {
    const tableLength = table.readUInt32LE(tableOffset + 4);
    let sum = 0;
    for (let i = 0; i < tableLength; i++) {
      sum = (sum + (table[tableOffset + i] ?? 0)) & 0xff;
    }
    return sum === 0;
  }
}
