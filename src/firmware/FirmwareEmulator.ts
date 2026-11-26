import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod";

export const firmwareEmulationModeSchema = z.enum([
  "auto",
  "uefi",
  "legacy",
  "peim",
]);
export type FirmwareEmulationMode = z.infer<typeof firmwareEmulationModeSchema>;

export const firmwareEmulationOptionsSchema = z.object({
  imagePath: z.string().min(1),
  mode: firmwareEmulationModeSchema.default("auto"),
  timeoutSec: z.number().positive().default(3.0),
  enableGdb: z.boolean().default(false),
  gdbPort: z.number().int().positive().default(1234),
  runnerScriptPath: z.string().optional(),
});
export type FirmwareEmulationOptions = z.infer<
  typeof firmwareEmulationOptionsSchema
>;

export interface FirmwareEmulationResult {
  image: string;
  size: number;
  mode: FirmwareEmulationMode;
  architectureInfo: {
    isUefi: boolean;
    isPhoenix: boolean;
    isPeim: boolean;
    hasResetVector: boolean;
    resetTarget: string;
  };
  durationSec: number;
  exitCode: number;
  status: string;
  logSize: number;
  instructionsExecuted?: number | undefined;
  milestones?: string[] | undefined;
  peiServicesInvoked?: number | undefined;
  ppisInstalled?: number | undefined;
  debugconLines?: number | undefined;
  rawStdout: string;
  rawStderr: string;
}

export class FirmwareEmulator {
  /**
   * Resolves the path to the universal QEMU BIOS runner script.
   */
  public static resolveRunnerScript(customPath?: string): string {
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    const candidatePaths = [
      // Relative from bios-re root
      path.resolve(process.cwd(), "toolkit/qemu_bios_runner.py"),
      path.resolve(process.cwd(), "../toolkit/qemu_bios_runner.py"),
      "/run/media/julian/ML6/bios-re/toolkit/qemu_bios_runner.py",
      "/run/media/julian/ML6/bios-re/toolkit/qemu-mod",
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    throw new Error(
      "Could not locate qemu_bios_runner.py. Please provide runnerScriptPath.",
    );
  }

  /**
   * Runs the universal firmware emulator on the target binary.
   */
  public static async emulate(
    options: FirmwareEmulationOptions,
  ): Promise<FirmwareEmulationResult> {
    const parsed = firmwareEmulationOptionsSchema.parse(options);
    const runner = this.resolveRunnerScript(parsed.runnerScriptPath);

    const args = [
      runner,
      parsed.imagePath,
      "--mode",
      parsed.mode,
      "--timeout",
      String(parsed.timeoutSec),
      "--json",
    ];

    if (parsed.enableGdb) {
      args.push("--gdb", "--gdb-port", String(parsed.gdbPort));
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("python3", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      proc.on("error", (err) => {
        reject(
          new Error(
            `Failed to spawn firmware emulator process: ${err.message}`,
          ),
        );
      });

      proc.on("close", (code) => {
        try {
          const raw = JSON.parse(stdout);
          const arch = raw.architecture_info ?? {};
          const analysis = raw.analysis ?? {};

          const result: FirmwareEmulationResult = {
            image: raw.image ?? parsed.imagePath,
            size: raw.size ?? 0,
            mode: raw.mode ?? parsed.mode,
            architectureInfo: {
              isUefi: Boolean(arch.is_uefi),
              isPhoenix: Boolean(arch.is_phoenix),
              isPeim: Boolean(arch.is_peim),
              hasResetVector: Boolean(arch.has_reset_vector),
              resetTarget: arch.reset_target ?? "UNKNOWN",
            },
            durationSec: raw.duration_sec ?? 0,
            exitCode: code ?? raw.exit_code ?? 0,
            status: analysis.status ?? "UNKNOWN",
            logSize: raw.log_size ?? 0,
            instructionsExecuted: analysis.instructions_executed,
            milestones: analysis.milestones,
            peiServicesInvoked: analysis.pei_services_invoked,
            ppisInstalled: analysis.ppis_installed,
            debugconLines: analysis.total_lines,
            rawStdout: stdout,
            rawStderr: stderr,
          };

          resolve(result);
        } catch (e) {
          if (code !== 0) {
            reject(
              new Error(
                `Firmware emulator failed with exit code ${code}: ${stderr || stdout}`,
              ),
            );
          } else {
            reject(
              new Error(
                `Failed to parse emulator JSON output: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
          }
        }
      });
    });
  }
}
