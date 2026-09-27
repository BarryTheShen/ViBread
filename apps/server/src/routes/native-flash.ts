import type { Request, Response, Router } from "express";
import { BOARD_PROFILES, BOARD_PROFILE_IDS, type BoardProfileId } from "@vibread/core";
import type { AppContext } from "../context.js";
import { createNativeFlasher, NativeFlashError, type NativeFlasher, type NativeFlashResult } from "../services/native-flash.js";

export type FirmwareKind = "bench" | "app";

/** The HEX the web flash uses (POST /bench/firmware): built once per revision and reused from its artifacts. */
export type MissionFirmware =
  | { ok: true; hex: string; board: BoardProfileId; calibration?: "measured" | "default" }
  | { ok: false; status: number; body: unknown };

export type MissionFirmwareSource = (missionId: string, kind: FirmwareKind) => Promise<MissionFirmware>;

function requireLocalUser(ctx: AppContext, req: Request, res: Response): void {
  if (!ctx.lanGuard.isLoopback(req)) throw new NativeFlashError(403, "lan_loopback_required", "Flashing with ViBread's uploader works only on the ViBread computer the board is plugged into");
  if (!res.locals.user && !ctx.config.singleOperator) throw new NativeFlashError(401, "UNAUTHORIZED", "sign in required");
}

/**
 * Native flashing for the computer the ViBread server runs on (issue #20): list the plugged-in Arduino ports and upload
 * a mission's bench/app HEX with the bundled arduino-cli (avrdude). Loopback only; mission routes sit behind the
 * mission-owner middleware.
 */
export function mountNativeFlashRoutes(router: Router, ctx: AppContext, firmware: MissionFirmwareSource, flasher: NativeFlasher = createNativeFlasher()): void {
  router.get("/bench/ports", async (req, res) => {
    requireLocalUser(ctx, req, res);
    res.json({ ports: await flasher.listPorts() });
  });

  router.post("/missions/:id/bench/native-flash", async (req, res) => {
    requireLocalUser(ctx, req, res);
    const missionId = String(req.params.id);
    const body = (req.body ?? {}) as { port?: unknown; which?: unknown; board?: unknown };
    if (body.which !== "bench" && body.which !== "app") throw new NativeFlashError(400, "INVALID_KIND", "which must be bench or app");
    if (typeof body.port !== "string" || !body.port) throw new NativeFlashError(400, "INVALID_PORT", "port is required");
    if (body.board !== undefined && !(typeof body.board === "string" && (BOARD_PROFILE_IDS as readonly string[]).includes(body.board))) {
      throw new NativeFlashError(400, "INVALID_BOARD", "board must be a known board profile");
    }
    const built = await firmware(missionId, body.which);
    if (!built.ok) return res.status(built.status).json(built.body);
    // The bench's "Bootloader profile" choice (e.g. a clone Nano's old bootloader) overrides the design's board.
    const chosen = body.board as BoardProfileId | undefined;
    const port = body.port;
    const tag = `native-flash ${body.which}`;
    const upload = (board: BoardProfileId): Promise<NativeFlashResult> => {
      ctx.debug.event(missionId, "bench", `${tag}: uploading to ${port} (${board}, bootloader ${BOARD_PROFILES[board].flash.baud} baud) with arduino-cli`);
      return flasher.flash({ port, board, hex: built.hex, onLine: (line) => ctx.debug.event(missionId, "bench", `${tag}: ${line}`) });
    };
    let board = chosen ?? built.board;
    let result = await upload(board);
    // Like the Web Serial flasher, try the other common bootloader speed when the board's own one gets no answer and
    // nobody chose a profile: clone Unos and Nanos often still carry the old 57600-baud bootloader.
    if (!result.ok && result.error.code === "not_in_sync" && chosen === undefined) {
      const other: BoardProfileId = BOARD_PROFILES[board].flash.baud === 115_200 ? "nano-atmega328p-old-5v" : "nano-atmega328p-5v";
      ctx.debug.event(missionId, "bench", `${tag}: no answer at ${BOARD_PROFILES[board].flash.baud} baud; trying the ${BOARD_PROFILES[other].flash.baud}-baud bootloader`, undefined, "warn");
      const first = result;
      board = other;
      result = await upload(board);
      result = { ...result, output: `${first.output}\n${result.output}`, durationMs: first.durationMs + result.durationMs };
    }
    const baud = BOARD_PROFILES[board].flash.baud;
    if (result.ok) {
      ctx.debug.event(missionId, "bench", `${tag}: flashed ${port} at ${baud} baud in ${result.durationMs} ms`);
      return res.json({ ok: true, output: result.output, port, which: body.which, board, baud, fqbn: result.fqbn, durationMs: result.durationMs, ...(body.which === "app" ? { calibration: built.calibration ?? "default" } : {}) });
    }
    ctx.debug.event(missionId, "bench", `${tag}: failed — ${result.error.code}: ${result.error.message}`, undefined, "warn");
    res.status(result.error.code === "timeout" ? 504 : 502).json({ ok: false, error: result.error, output: result.output, port, which: body.which, board, baud, fqbn: result.fqbn, durationMs: result.durationMs });
  });
}
