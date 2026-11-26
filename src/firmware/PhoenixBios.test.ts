import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  PhoenixBiosParser,
  PhoenixLzhDecompressor,
  PhoenixAcpiPatcher,
} from "./PhoenixBios.js";

describe("PhoenixBiosParser", () => {
  it("rejects buffers smaller than minimum BIOS size", () => {
    const small = Buffer.alloc(1024);
    const parser = new PhoenixBiosParser(small);
    expect(() => parser.parse()).toThrow(/Invalid Phoenix BIOS size/);
  });

  it("correctly identifies BCP modules, system info, and reset vector", () => {
    const realBiosPath =
      "/run/media/julian/ML6/bios-re/images/e5010/dumps/e5010_bios_pm49fl004.bin";
    if (!existsSync(realBiosPath)) {
      return;
    }

    const rom = readFileSync(realBiosPath);
    const parser = new PhoenixBiosParser(rom);
    const report = parser.parse();

    expect(report.fileSize).toBe(524288);
    expect(report.bcpTableOffset).toBeGreaterThan(0);
    expect(report.systemInfoOffset).toBeGreaterThan(0);
    expect(report.version).toContain("DEVEL33I");
    expect(report.resetVector.jumpTarget).toBe("F000:B65B");

    // Check that core BCP tables are registered
    const bcpSigs = report.bcpModules.map((m) => m.signature);
    expect(bcpSigs).toContain("BCPCHP");
    expect(bcpSigs).toContain("BCPHDD");
    expect(bcpSigs).toContain("BCPCPU");
    expect(bcpSigs).toContain("BCPACP");
    expect(bcpSigs).toContain("BCPNVS");

    // Check that standard compressed modules are mapped
    const modNames = report.modules.map((m) => m.name);
    expect(modNames).toContain("_A00"); // DSDT
    expect(modNames).toContain("_A01"); // FACP v1
    expect(modNames).toContain("_A02"); // FACP v3
    expect(modNames).toContain("_M00"); // Microcode
    expect(modNames).toContain("_Q00"); // ACPI loader

    const dsdtMod = report.modules.find((m) => m.name === "_A00");
    expect(dsdtMod).toBeDefined();
    expect(dsdtMod?.decompressedSize).toBe(16252);
    expect(dsdtMod?.classType).toBe("ACPI_TABLE");
  });

  it("patches DSDT LNKH errors and produces a valid ACPI table checksum", () => {
    const dsdtPath =
      "/run/media/julian/ML6/bios-re/images/e5010/dumps/e5010_dsdt.dat";
    if (!existsSync(dsdtPath)) {
      return;
    }

    const dsdt = readFileSync(dsdtPath);
    expect(PhoenixAcpiPatcher.verifyChecksum(dsdt)).toBe(true);

    const result = PhoenixAcpiPatcher.patchDsdtLnkH(dsdt);
    expect(result.replacements).toBe(8);
    expect(PhoenixAcpiPatcher.verifyChecksum(result.patched)).toBe(true);

    // Assert that no LNKH remains in the patched table
    expect(result.patched.includes(Buffer.from("LNKH", "ascii"))).toBe(false);
    // Assert that LNKA, LNKB, LNKC, LNKD now exist
    expect(result.patched.includes(Buffer.from("LNKA", "ascii"))).toBe(true);
    expect(result.patched.includes(Buffer.from("LNKB", "ascii"))).toBe(true);
    expect(result.patched.includes(Buffer.from("LNKC", "ascii"))).toBe(true);
    expect(result.patched.includes(Buffer.from("LNKD", "ascii"))).toBe(true);
  });
});
