import { describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { FirmwareEmulator } from "./FirmwareEmulator.js";

describe("FirmwareEmulator", () => {
  it("resolves the universal runner script path", () => {
    const runner = FirmwareEmulator.resolveRunnerScript();
    expect(fs.existsSync(runner)).toBe(true);
    expect(runner).toContain("qemu_bios_runner.py");
  });

  it("emulates a 32-bit UEFI PEIM module", async () => {
    const peimPath =
      "/run/media/julian/ML6/bios-re/scratches/p4_SmBusPei_FId_o139.pe.bin";
    if (!fs.existsSync(peimPath)) {
      return;
    }

    const res = await FirmwareEmulator.emulate({
      imagePath: peimPath,
      mode: "peim",
      timeoutSec: 3.0,
    });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("PEIM_SUCCESS");
    expect(res.architectureInfo.isPeim).toBe(true);
    expect(res.peiServicesInvoked).toBeGreaterThan(0);
    expect(res.ppisInstalled).toBeGreaterThan(0);
  });

  it("emulates a 16-bit legacy Phoenix BIOS image", async () => {
    const biosPath =
      "/run/media/julian/ML6/bios-re/images/e5010/dumps/e5010_bios_pm49fl004.bin";
    if (!fs.existsSync(biosPath)) {
      return;
    }

    const res = await FirmwareEmulator.emulate({
      imagePath: biosPath,
      mode: "legacy",
      timeoutSec: 1.0,
    });

    expect(res.exitCode).toBe(0);
    expect(res.status).toBe("EXECUTION_ACTIVE");
    expect(res.architectureInfo.hasResetVector).toBe(true);
    expect(res.architectureInfo.resetTarget).toBe("F000:B65B");
    expect(res.instructionsExecuted).toBeGreaterThan(1000);
  });
});
