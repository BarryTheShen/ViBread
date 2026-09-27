import { Router, type Express, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { heifToJpeg } from "heif2jpeg";
import type {
  Actor,
  BenchRunRequest,
  CompileResult,
  Mission,
  ReleaseRequest,
  Revision,
  RevisionResults,
} from "@vibread/core";
import { HARDWARE_KINDS, MODULES, normalizeObservation, parsePartsText, type HardwareKind, type HardwareView } from "@vibread/core";
import type { CatalogView, InventoryEntry, InventoryUpsertRequest, PartType, ScanAcceptRequest, ScanItem } from "@vibread/core";
import { applyCalibration, compileBenchFirmware, compileSketch, uploadCommand } from "@vibread/firmware";
import { calibrationMacros, evaluateRun, planSelfTest } from "@vibread/bench";
import { loadFaultDictionary } from "@vibread/tools";
import { z } from "zod";
import { runs } from "./db/schema.js";
import { parseMyHardware } from "./services/hardware.js";
import { SqlApprovalBroker } from "./services/approvals.js";
import { SqlMissionStore } from "./store/missions.js";
import { BUILD_STEP_EVENT, doneSteps } from "./services/build-progress.js";
import { WIRE_COLOR_EVENT, wireColorChange, wireOverrides } from "./services/wire-colors.js";
import type { PhotonSettings } from "./capcom/index.js";
import { mergeCapcomPrefs } from "./capcom/prefs.js";
import { BUILD_VERSION } from "./version.js";
import type { AppContext } from "./context.js";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const fieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const inventoryUpsertSchema = z.object({
  items: z.array(z.object({
    typeId: z.string().min(1),
    values: z.record(z.string(), fieldValueSchema),
    quantity: z.number().int().positive(),
    mode: z.enum(["add", "replace"]).default("add"),
    source: z.enum(["scan", "typed", "manual", "preset"]).default("manual"),
    status: z.enum(["ready", "needs-look"]).optional(),
    candidates: z.array(z.record(z.string(), fieldValueSchema)).optional(),
    photoUrl: z.string().optional(),
    note: z.string().optional(),
  })).min(1),
});

interface WebUser {
  id: string;
  name: string;
  email?: string;
  image?: string;
}

export function missionOwnerMiddleware(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = userFromLocals(res);
      if (!user) return next(httpError(401, "UNAUTHORIZED", "sign in required"));
      const mission = await ctx.store.getMission(String(req.params.id));
      if (!mission || mission.ownerId !== user.id) return next(httpError(404, "MISSION_NOT_FOUND", "mission not found"));
      res.locals.mission = mission;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function approvalOwnerMiddleware(ctx: AppContext): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = userFromLocals(res);
      if (!user) return next(httpError(401, "UNAUTHORIZED", "sign in required"));
      const approval = await ctx.broker.get(String(req.params.approvalId));
      if (approval) {
        const mission = await ctx.store.getMission(approval.missionId);
        if (!mission || mission.ownerId !== user.id) return next(httpError(404, "MISSION_NOT_FOUND", "mission not found"));
        res.locals.mission = mission;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}


export function mountApi(app: Express, ctx: AppContext): void {
  const router = Router();
  router.get("/version", (_req, res) => {
    res.json({ ...BUILD_VERSION, runtime: process.env.VIBREAD_RUNTIME === "desktop" ? "desktop" : "server" });
  });
  router.get("/me", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json({ user, auth: ctx.config.singleOperator ? "single-operator" : "google" });
  });
  router.get("/modules", (_req, res) => {
    res.json(Object.values(MODULES).map((module) => ({ key: module.key, name: module.name, description: module.description, category: module.category })));
  });
  router.get("/catalog", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.catalog.view(user.id));
  });
  router.post("/catalog/types", async (req, res) => {
    const user = actorUser(res, ctx);
    const type = req.body as PartType;
    if (!type || typeof type.name !== "string" || typeof type.category !== "string") throw httpError(400, "INVALID_PART_TYPE", "part type is invalid");
    res.status(201).json(await ctx.catalog.upsert(user.id, type));
  });
  router.patch("/catalog/types/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.catalog.update(user.id, String(req.params.id), req.body as Partial<PartType>));
  });
  router.delete("/catalog/types/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    await ctx.catalog.remove(user.id, String(req.params.id), req.query.force === "true");
    res.json({ ok: true });
  });
  router.get("/inventory", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.inventory.view(user.id));
  });
  router.post("/inventory/items", async (req, res) => {
    const user = actorUser(res, ctx);
    const parsed = inventoryUpsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw httpError(400, "INVALID_INVENTORY", parsed.error.message);
    for (const item of parsed.data.items) {
      const type = await ctx.catalog.get(user.id, item.typeId);
      if (!type) throw httpError(400, "UNKNOWN_PART_TYPE", `Unknown part type ${item.typeId}`);
      const unknown = Object.keys(item.values).filter((key) => !type.fields.some((field) => field.key === key));
      if (unknown.length) throw httpError(400, "UNKNOWN_FIELD", `Unknown field(s) for ${item.typeId}: ${unknown.join(", ")}`);
    }
    res.status(201).json(await ctx.inventory.upsert(user.id, parsed.data));
  });
  router.patch("/inventory/items/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.inventory.update(user.id, String(req.params.id), req.body as Partial<InventoryEntry>));
  });
  router.delete("/inventory/items/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    await ctx.inventory.remove(user.id, String(req.params.id));
    res.json({ ok: true });
  });
  router.post("/inventory/parse", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim().length === 0) throw httpError(400, "INVALID_TEXT", "text is required");
    res.json({ lines: parsePartsText(body.text, await ctx.inventory.types(user.id)) });
  });
  router.post("/inventory/scans", async (req, res) => {
    const user = actorUser(res, ctx);
    const scan = await ctx.scans.create(user.id);
    ctx.debug.event(scan.id, "scan", "scan created", { ownerId: user.id });
    res.status(201).json(scan);
  });
  router.post("/inventory/scans/:id/photos", upload.single("photo"), async (req, res) => {
    const user = actorUser(res, ctx);
    if (!req.file) throw httpError(400, "PHOTO_REQUIRED", "multipart photo is required");
    const jpeg = await uploadedJpeg(req.file);
    const hash = await ctx.store.putArtifact(jpeg, "image/jpeg");
    const saved = await ctx.scans.addPhoto(user.id, String(req.params.id), hash);
    ctx.debug.event(String(req.params.id), "scan", "scan photo uploaded", { bytes: jpeg.byteLength });
    res.json(saved);
  });
  router.post("/inventory/scans/:id/analyze", async (req, res) => {
    const user = actorUser(res, ctx);
    const scanId = String(req.params.id);
    try {
      const hashes = await ctx.scans.photoHashes(user.id, scanId);
      const photos: Buffer[] = [];
      for (const hash of hashes) {
        const artifact = await ctx.store.getArtifact(hash);
        if (!artifact) throw httpError(404, "PHOTO_NOT_FOUND", "scan photo not found");
        photos.push(Buffer.from(artifact.data));
      }
      const types = await ctx.inventory.types(user.id);
      const identified = await ctx.runtime.scan.identifyParts({ ownerId: user.id, photos, types });
      const analyzed: Array<{ hash: string; width: number; height: number }> = [];
      for (const image of identified.analyzed) {
        const hash = await ctx.store.putArtifact(image.jpeg, "image/jpeg");
        analyzed.push({ hash, width: image.width, height: image.height });
      }
      const inventory = await ctx.inventory.entries(user.id);
      const items: ScanItem[] = identified.observations.map((observation, index) => {
        const normalized = normalizeObservation(observation, types);
        const existing = normalized.typeId ? inventory.find((entry) => entry.typeId === normalized.typeId) : undefined;
        return { ...normalized, index, cropUrl: `/api/inventory/scans/${scanId}/crops/${index}`, ...(existing ? { existing: { entryId: existing.id, quantity: existing.quantity } } : {}) };
      });
      const view = await ctx.scans.analyze(user.id, scanId, { observations: identified.observations, analyzed, items }, types, inventory);
      res.json(view);
    } catch (error) {
      if (typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" && ((error as { status: number }).status < 500 && (error as { status: number }).status !== 429)) throw error;
      const failure = scanFailure(error);
      const retryAt = failure.retryAfter;
      await ctx.scans.fail(user.id, scanId, failure);
      ctx.debug.event(scanId, "scan", "scan analysis failed", { code: failure.code, retryAfter: retryAt }, "error");
      const responseError = Object.assign(new Error(failure.message), { status: failure.status, code: failure.code, ...(retryAt ? { retryAt } : {}) });
      throw responseError;
    }
  });
  router.get("/inventory/scans/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    const scan = await ctx.scans.get(user.id, String(req.params.id));
    if (!scan) throw httpError(404, "SCAN_NOT_FOUND", "scan not found");
    const claude = (await ctx.claudeAccounts.view(user.id)).using === "none" ? "missing" : "connected";
    res.json({ ...scan, claude });
  });
  router.get("/inventory/scans/:id/crops/:index", async (req, res) => {
    const user = actorUser(res, ctx);
    const scanId = String(req.params.id);
    const index = parseNonNegativeInt(req.params.index);
    const observations = await ctx.scans.observations(user.id, scanId);
    const analyzed = await ctx.scans.analyzed(user.id, scanId);
    const observation = observations[index];
    const image = observation ? analyzed[observation.photoIndex] : undefined;
    if (!observation || !image) throw httpError(404, "CROP_NOT_FOUND", "scan crop not found");
    const artifact = await ctx.store.getArtifact(image.hash);
    if (!artifact) throw httpError(404, "PHOTO_NOT_FOUND", "scan image not found");
    const crop = await ctx.runtime.scan.cutCrop(Buffer.from(artifact.data), observation.box);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(crop));
  });
  router.post("/inventory/scans/:id/accept", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as ScanAcceptRequest;
    if (!body || !Array.isArray(body.items)) throw httpError(400, "INVALID_SCAN_ACCEPT", "items are required");
    const entries = await ctx.scans.accept(user.id, String(req.params.id), body.items, ctx.inventory);
    ctx.debug.event(String(req.params.id), "scan", "scan accepted", { items: body.items.length });
    res.json(entries);
  });
  // "Your hardware" (issue #23): the breadboard, board and part variants new missions default to.
  const hardwareView = async (ownerId: string): Promise<HardwareView> => {
    const { hardware, source } = await ctx.hardware.get(ownerId);
    return { hardware, source, claude: (await ctx.claudeAccounts.view(ownerId)).using === "none" ? "missing" : "connected" };
  };
  router.get("/inventory/hardware", async (_req, res) => {
    res.json(await hardwareView(actorUser(res, ctx).id));
  });
  router.put("/inventory/hardware", async (req, res) => {
    const user = actorUser(res, ctx);
    await ctx.hardware.save(user.id, parseMyHardware(req.body));
    res.json(await hardwareView(user.id));
  });
  /**
   * Identify from a photo → HardwareIdentification to confirm. The photo is a multipart "photo" (JPEG/PNG/HEIC, from
   * an upload or this computer's camera) or the latest photo of a scan (`scanId`: the phone took it through the scan
   * page's QR link). Optional `kind` says what the photo shows.
   */
  router.post("/inventory/hardware/identify", upload.single("photo"), async (req, res) => {
    const user = actorUser(res, ctx);
    const body = (req.body ?? {}) as { kind?: unknown; scanId?: unknown };
    if (body.kind !== undefined && body.kind !== "" && !(HARDWARE_KINDS as readonly string[]).includes(String(body.kind))) throw httpError(400, "INVALID_KIND", `kind must be one of ${HARDWARE_KINDS.join(", ")}`);
    const kind = body.kind ? (String(body.kind) as HardwareKind) : undefined;
    let photo: Buffer;
    if (req.file) photo = await uploadedJpeg(req.file);
    else if (typeof body.scanId === "string" && body.scanId) {
      const latest = (await ctx.scans.photoHashes(user.id, body.scanId)).at(-1);
      const artifact = latest ? await ctx.store.getArtifact(latest) : null;
      if (!artifact) throw httpError(404, "PHOTO_NOT_FOUND", "This scan has no photo yet.");
      photo = Buffer.from(artifact.data);
    } else throw httpError(400, "PHOTO_REQUIRED", "a multipart photo or a scanId is required");
    try {
      res.json(await ctx.runtime.scan.identifyHardware({ ownerId: user.id, photo, ...(kind ? { kind } : {}) }));
    } catch (error) {
      if (typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" && (error as { status: number }).status < 500 && (error as { status: number }).status !== 429) throw error;
      const failure = scanFailure(error);
      throw Object.assign(new Error(failure.code === "claude_error" ? "Claude couldn't identify this photo. Pick yours from the list or try another photo." : failure.message), { status: failure.status, code: failure.code, ...(failure.retryAfter ? { retryAt: failure.retryAfter } : {}) });
    }
  });
  router.get("/missions", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.missions.list(user.id));
  });
  router.post("/missions", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { brief?: unknown; inventory?: unknown; inventoryEntryIds?: unknown; title?: unknown };
    if (typeof body.brief !== "string" || body.brief.trim().length === 0 || (body.inventory !== undefined && !Array.isArray(body.inventory)) || (body.inventoryEntryIds !== undefined && (!Array.isArray(body.inventoryEntryIds) || body.inventoryEntryIds.some((id) => typeof id !== "string")))) {
      throw httpError(400, "INVALID_REQUEST", "brief and optional inventoryEntryIds or inventory are required");
    }
    const mission = await ctx.missions.create({
      brief: body.brief,
      ...(Array.isArray(body.inventory) ? { inventory: body.inventory as Mission["inventory"] } : {}),
      ...(Array.isArray(body.inventoryEntryIds) ? { inventoryEntryIds: body.inventoryEntryIds as string[] } : {}),
      title: typeof body.title === "string" ? body.title : undefined,
      owner: { kind: "human", id: user.id, name: user.name, channel: "web" },
    });
    res.status(201).json(toSummary(mission));
  });
  router.get("/missions/:id", async (req, res) => {
    res.json(await ctx.missions.detail(String(req.params.id)));
  });
  router.patch("/missions/:id", async (req, res) => {
    const body = (req.body ?? {}) as { title?: unknown };
    const missionId = String(req.params.id);
    if (typeof body.title !== "string" || body.title.trim().length < 1 || body.title.trim().length > 80) {
      throw httpError(400, "INVALID_TITLE", "title must be 1–80 characters");
    }
    await ctx.store.updateMission(missionId, { title: body.title.trim() });
    const mission = await ctx.store.getMission(missionId);
    if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    res.json(toSummary(mission));
  });
  router.delete("/missions/:id", async (req, res) => {
    const missionId = String(req.params.id);
    const mission = await ctx.store.getMission(missionId);
    if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    (ctx.store as SqlMissionStore).deleteMission(missionId);
    res.json({ ok: true });
  });
  router.get("/missions/:id/timeline", async (req, res) => {
    res.json(await ctx.missions.events(String(req.params.id), typeof req.query.after === "string" ? req.query.after : undefined));
  });
  router.get("/missions/:id/revisions", async (req, res) => {
    const revisions = await ctx.store.listRevisions(String(req.params.id));
    res.json(revisions.map(toRevisionSummary));
  });
  router.get("/missions/:id/revisions/:n", async (req, res) => {
    const missionId = String(req.params.id);
    const n = parsePositiveInt(req.params.n);
    const revision = await ctx.store.getRevision(missionId, n);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const artifactUrls: Record<string, string> = {};
    for (const key of Object.keys(revision.results.artifacts)) artifactUrls[key] = artifactUrl(missionId, n, key);
    const fallbackUpload = uploadCommand({ hexPath: "<downloaded .hex file>", port: "<port>", board: revision.circuit.board.profile });
    res.json({ n: revision.n, hash: revision.hash, circuit: revision.circuit, suite: revision.suite, results: revision.results, artifactUrls, fallbackUpload });
  });
  router.get("/missions/:id/revisions/:n/artifacts/:key", async (req, res) => {
    const missionId = String(req.params.id);
    const n = parsePositiveInt(req.params.n);
    const key = String(req.params.key);
    const revision = await ctx.store.getRevision(missionId, n);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const hash = revision.results.artifacts[key];
    if (!hash) throw httpError(404, "ARTIFACT_NOT_FOUND", "artifact not found");
    const artifact = await ctx.store.getArtifact(hash);
    if (!artifact) throw httpError(404, "ARTIFACT_NOT_FOUND", "artifact not found");
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (artifact.contentType.toLowerCase().startsWith("image/svg+xml")) {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(artifact.data));
  });
  router.post("/approvals/:approvalId", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { decision?: unknown };
    if (body.decision !== "approve-once" && body.decision !== "approve-mission" && body.decision !== "deny") {
      throw httpError(400, "INVALID_DECISION", "decision is invalid");
    }
    const view = await ctx.missions.decide(String(req.params.approvalId), body.decision, { kind: "human", id: user.id, name: user.name, channel: "web" });
    res.json(view);
  });
  router.post("/missions/:id/confirm", async (req, res) => {
    const missionId = String(req.params.id);
    const mission = await ctx.store.getMission(missionId);
    if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    const released = mission.releasedRevision === undefined ? null : await ctx.store.getRevision(missionId, mission.releasedRevision);
    const latestBench = latestFullBenchRun(released);
    if (!latestBench) throw httpError(409, "bench_run_required", "Run the bench test with your Arduino first.");
    if (latestBench.verdict === "incomplete") throw httpError(409, "bench_run_incomplete", "The last bench test didn't finish. Run it again and answer each question on the bench screen.");
    if (latestBench.verdict !== "pass") throw httpError(409, "bench_run_failed", "The last bench test didn't pass. Fix the wiring and run it again.");
    if (latestBench.runId.startsWith("virtual-")) {
      throw httpError(409, "real_board_required", "The virtual board passed. Run the bench with your real Arduino to complete the mission.");
    }
    const phase = await ctx.machine.phase(missionId);
    if (phase !== "LAUNCH") throw httpError(409, "bad_phase", "mission can only be confirmed after launch");
    const next = await ctx.machine.send(missionId, { type: "USER_CONFIRMED" });
    if (next !== "DONE") throw httpError(409, "bad_phase", "mission could not be confirmed from its current phase");
    const actor = actorFor(res, ctx);
    await ctx.store.appendEvent({
      missionId,
      channel: actor.channel,
      actor,
      kind: "mission.confirmed",
      text: "Mission complete confirmed",
      revision: mission.currentRevision,
      data: { phase: next },
    });
    res.json(await ctx.missions.detail(missionId));
  });

  router.post("/missions/:id/release", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = (req.body ?? {}) as Partial<ReleaseRequest>;
    const revision = parsePositiveInt(body.revision);
    if (body.acknowledgeMissingReview !== undefined && typeof body.acknowledgeMissingReview !== "boolean") {
      throw httpError(400, "INVALID_ACKNOWLEDGEMENT", "acknowledgeMissingReview must be a boolean");
    }
    const missionId = String(req.params.id);
    const mission = await ctx.store.getMission(missionId);
    if (!mission || mission.ownerId !== user.id) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    const detail = await ctx.runtime.release({
      missionId,
      revision,
      actor: { kind: "human", id: user.id, name: user.name, channel: "web" },
      ...(body.acknowledgeMissingReview ? { acknowledgeMissingReview: true } : {}),
    });
    res.json(detail);
  });
  router.get("/missions/:id/build", async (req, res) => {
    res.json(await ctx.missions.build(String(req.params.id)));
  });
  router.get("/missions/:id/bench/requests", async (req, res) => {
    const missionId = String(req.params.id);
    const current = await currentRevisionForBench(ctx, missionId);
    if (current.revision === null) {
      res.json({ requests: [] });
      return;
    }
    const requests = await sqlApprovalBroker(ctx).listBenchRequests(missionId, current.hash, current.revision);
    res.json({ requests });
  });
  router.post("/missions/:id/bench/requests/:approvalId/start", async (req, res) => {
    const missionId = String(req.params.id);
    const current = await currentRevisionForBench(ctx, missionId);
    if (current.revision === null) throw httpError(409, "request_not_runnable", "Nothing is released for the bench yet");
    const approval = await ctx.broker.get(String(req.params.approvalId));
    if (approval?.action === "flash-app") {
      const released = await ctx.store.getRevision(missionId, current.revision);
      const latestBench = latestFullBenchRun(released);
      if (!latestBench || latestBench.verdict !== "pass") throw httpError(409, "needs_passing_selftest", "Run a passing bench self-test before flashing the app.");
    }
    const started = await sqlApprovalBroker(ctx).startBenchRequest({
      approvalId: String(req.params.approvalId),
      missionId,
      revisionHash: current.hash,
      revision: current.revision,
      actor: actorFor(res, ctx),
    });
    res.json(started);
  });
  router.post("/missions/:id/bench/requests/:approvalId/deny", async (req, res) => {
    const missionId = String(req.params.id);
    const current = await currentRevisionForBench(ctx, missionId);
    if (current.revision === null) throw httpError(409, "request_not_runnable", "Nothing is released for the bench yet");
    await sqlApprovalBroker(ctx).denyBenchRequest({
      approvalId: String(req.params.approvalId),
      missionId,
      revisionHash: current.hash,
      revision: current.revision,
      actor: actorFor(res, ctx),
    });
    res.status(204).send();
  });
  router.post("/missions/:id/bench/asks", async (req, res) => {
    const body = req.body as { askId?: unknown; test?: unknown; kind?: unknown; part?: unknown; prompt?: unknown; choices?: unknown; timeoutMs?: unknown };
    const choices = Array.isArray(body.choices) ? body.choices : [];
    if (typeof body.askId !== "string" || typeof body.test !== "string" || typeof body.kind !== "string" || typeof body.prompt !== "string" || body.prompt.length > 300 || choices.length < 1 || choices.some((choice) => typeof choice !== "string" || choice.length === 0) || typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > 300_000) {
      throw httpError(400, "INVALID_REQUEST", "askId, test, kind, prompt (≤300 chars), non-empty choices, and timeoutMs (1-300 seconds) are required");
    }
    const ask = ctx.benchAsks.open({
      missionId: String(req.params.id),
      askId: body.askId,
      test: body.test,
      kind: body.kind,
      ...(typeof body.part === "string" ? { part: body.part } : {}),
      prompt: body.prompt,
      choices: body.choices as string[],
      timeoutMs: body.timeoutMs,
    });
    res.status(201).json(ask);
  });
  router.get("/missions/:id/bench/asks/:askId", async (req, res) => {
    const ask = ctx.benchAsks.get(String(req.params.id), String(req.params.askId));
    if (!ask) throw httpError(404, "ASK_NOT_FOUND", "bench ask not found");
    res.json(ask);
  });
  router.post("/missions/:id/bench/asks/:askId/close", async (req, res) => {
    const missionId = String(req.params.id);
    const askId = String(req.params.askId);
    const ask = ctx.benchAsks.get(missionId, askId);
    if (!ask) throw httpError(404, "ASK_NOT_FOUND", "bench ask not found");
    const body = req.body as { answer?: unknown };
    if (body.answer !== undefined && (typeof body.answer !== "string" || (body.answer !== "timeout" && !ask.choices.includes(body.answer)))) {
      throw httpError(400, "INVALID_REQUEST", "answer must be one of the ask choices or timeout");
    }
    ctx.benchAsks.close(missionId, askId, body.answer as string | undefined);
    res.status(204).send();
  });


  router.post("/missions/:id/build/step", async (req, res) => {
    const missionId = String(req.params.id);
    const mission = await ctx.store.getMission(missionId);
    if (!mission || mission.releasedRevision === undefined) throw httpError(409, "not_released", "Press GO for build first.");
    const n = parsePositiveInt((req.body as { n?: unknown }).n);
    const before = await ctx.missions.build(missionId);
    const alreadyDone = before.revision !== undefined && doneSteps(await ctx.store.listEvents(missionId), before.revision).includes(n);
    if (alreadyDone) {
      res.json(before);
      return;
    }
    await ctx.store.appendEvent({
      missionId,
      channel: "web",
      actor: actorFor(res, ctx),
      kind: BUILD_STEP_EVENT,
      text: `Step ${n} done`,
      revision: before.revision,
      data: { n },
    });
    await ctx.machine.send(missionId, { type: "BUILD_STEP", n });
    if (before.steps.length > 0 && n >= before.steps.length) {
      await ctx.machine.send(missionId, { type: "BUILD_DONE" });
    }
    res.json(await ctx.missions.build(missionId));
  });
  /** The revision Build Mode shows (released, else the latest) with the builder's wire-colour overrides. */
  async function buildRevision(missionId: string): Promise<{ revision: Revision; overrides: Record<string, string> }> {
    const mission = await ctx.store.getMission(missionId);
    const n = mission?.releasedRevision ?? mission?.currentRevision;
    const revision = n === undefined ? null : await ctx.store.getRevision(missionId, n);
    if (!revision?.results.layout) throw httpError(404, "LAYOUT_NOT_FOUND", "This design has no breadboard layout yet.");
    return { revision, overrides: wireOverrides(await ctx.store.listEvents(missionId), revision.n) };
  }
  router.post("/missions/:id/build/wire-color", async (req, res) => {
    const missionId = String(req.params.id);
    const { revision } = await buildRevision(missionId);
    const change = wireColorChange(revision, req.body);
    if ("error" in change) throw httpError(400, "INVALID_WIRE_COLOR", change.error);
    await ctx.store.appendEvent({ missionId, channel: "web", actor: actorFor(res, ctx), kind: WIRE_COLOR_EVENT, text: change.text, revision: revision.n, data: change.data });
    res.json(await ctx.missions.build(missionId));
  });
  router.get("/missions/:id/build/steps/:file", async (req, res) => {
    const match = /^(\d+)\.(svg|png)$/.exec(String(req.params.file));
    if (!match) throw httpError(404, "STEP_NOT_FOUND", "step picture not found");
    const { revision, overrides } = await buildRevision(String(req.params.id));
    const { buildSteps, jumperColors, renderBreadboardSvg, svgToPng } = await import("@vibread/assembly");
    const layout = revision.results.layout!;
    const wireColors = jumperColors(revision.circuit, layout, overrides);
    const steps = buildSteps(revision.circuit, layout, { wireColors });
    const n = Number(match[1]);
    if (n < 1 || n > steps.steps.length) throw httpError(404, "STEP_NOT_FOUND", "step picture not found");
    const svg = renderBreadboardSvg({ circuit: revision.circuit, layout, steps, upToStep: n, wireColors, ...(req.query.focus === "1" ? { focus: true } : {}) });
    res.setHeader("X-Content-Type-Options", "nosniff");
    // URLs carry ?v=<hash of revision + overrides>, so a colour change is a new URL; the drawing code can still change
    // between deploys, so browsers revalidate (express answers 304 from the ETag).
    res.setHeader("Cache-Control", "private, no-cache");
    if (match[2] === "svg") {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
      res.type("image/svg+xml").send(svg);
      return;
    }
    res.type("image/png").send(Buffer.from(await svgToPng(svg, 1200)));
  });
  /** The finished board with the builder's wire colours (Try it and the bench's virtual board draw from this). */
  router.get("/missions/:id/build/breadboard.svg", async (req, res) => {
    const { revision, overrides } = await buildRevision(String(req.params.id));
    const { jumperColors, renderBreadboardSvg } = await import("@vibread/assembly");
    const layout = revision.results.layout!;
    const svg = renderBreadboardSvg({ circuit: revision.circuit, layout, ...(revision.results.steps ? { steps: revision.results.steps } : {}), wireColors: jumperColors(revision.circuit, layout, overrides) });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.setHeader("Cache-Control", "private, no-cache");
    res.type("image/svg+xml").send(svg);
  });
  router.get("/missions/:id/build/schematic.svg", async (req, res) => {
    const { revision, overrides } = await buildRevision(String(req.params.id));
    const { netColors, renderSchematicSvg } = await import("@vibread/assembly");
    const svg = await renderSchematicSvg(revision.circuit, { netColors: netColors(revision.circuit, overrides, revision.results.layout) });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.setHeader("Cache-Control", "private, no-cache");
    res.type("image/svg+xml").send(svg);
  });
  router.post("/missions/:id/bench/firmware", async (req, res) => {
    const missionId = String(req.params.id);
    const body = req.body as { kind?: unknown };
    if (body.kind !== "bench" && body.kind !== "app") throw httpError(400, "INVALID_KIND", "kind must be bench or app");
    const mission = await ctx.store.getMission(missionId);
    if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    if (mission.releasedRevision === undefined) throw httpError(409, "RELEASE_REQUIRED", "Press GO for build first");
    const revision = await ctx.store.getRevision(missionId, mission.releasedRevision);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "released revision not found");
    const key = body.kind === "bench" ? "bench.hex" : "app.hex";
    const fallbackUpload = uploadCommand({ hexPath: "<downloaded .hex file>", port: "<port>", board: revision.circuit.board.profile });
    const cachedHash = revision.results.artifacts[key];
    if (cachedHash) {
      const cached = await ctx.store.getArtifact(cachedHash);
      if (cached) return res.json({ hex: Buffer.from(cached.data).toString("utf8"), design: revision.hash, fallbackUpload, ...(body.kind === "bench" ? { plan: revision.results.selftest } : {}) });
    }
    let plan = revision.results.selftest;
    let compile: CompileResult;
    if (body.kind === "bench") {
      plan = planSelfTest(revision.circuit, revision.hash);
      compile = await compileBenchFirmware(plan);
    } else {
      const calibrations = revision.results.bench?.at(-1)?.calibration ?? [];
      compile = await compileSketch({
        source: applyCalibration(revision.circuit.sketch.source, calibrationMacros(calibrations)),
        board: revision.circuit.board.profile,
      });
    }
    if (!compile.ok || !compile.hex) {
      const { hex: _hex, ...withoutBinary } = compile;
      await ctx.store.saveResults(missionId, revision.n, { compile: withoutBinary, ...(body.kind === "bench" && plan ? { selftest: plan } : {}) });
      return res.status(422).json({ error: { code: "COMPILE_FAILED", message: compile.log || "firmware compilation failed" }, diagnostics: compile.diagnostics });
    }
    const artifactHash = await ctx.store.putArtifact(compile.hex, "text/plain; charset=utf-8");
    const { hex: _hex, ...withoutBinary } = compile;
    const resultPatch: Partial<RevisionResults> = {
      compile: withoutBinary,
      artifacts: { [key]: artifactHash },
      ...(body.kind === "bench" && plan ? { selftest: plan } : {}),
    };
    await ctx.store.saveResults(missionId, revision.n, resultPatch);
    res.json({ hex: compile.hex, design: revision.hash, fallbackUpload, ...(body.kind === "bench" ? { plan } : {}) });
  });
  router.post("/missions/:id/bench/runs", async (req, res) => {
    const missionId = String(req.params.id);
    const body = req.body as BenchRunRequest & { runId?: unknown };
    const runPrefix = typeof body.runId === "string" && body.runId.startsWith("virtual-") ? "virtual" : "run";
    const revision = await ctx.store.getRevision(missionId, body.revision);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const serverPlan = revision.results.selftest;
    if (!serverPlan) throw httpError(409, "SELFTEST_PLAN_REQUIRED", "This revision has no server-generated self-test plan.");
    // A Build Steps checkpoint runs a few of the plan's tests (issue 21); judge only those, and only ones the server's
    // own plan has. Everything else about the plan stays the server's.
    const requested = Array.isArray(body.plan?.tests) ? serverPlan.tests.filter((test) => body.plan.tests.includes(test)) : [];
    const plan = requested.length > 0 && requested.length < serverPlan.tests.length ? { ...serverPlan, tests: requested } : serverPlan;
    // PLAN item 14: rank single-fault mutants when the background fault dictionary (faults.json) is ready.
    const faultDictionary = await loadFaultDictionary(ctx.store, revision.results.artifacts);
    const result = await evaluateRun({
      circuit: revision.circuit,
      layout: revision.results.layout,
      plan,
      lines: body.lines,
      answers: body.answers,
      kind: body.kind,
      revision: revision.n,
      runId: `${runPrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...(faultDictionary ? { faultDictionary } : {}),
    });
    // Which build step's checkpoint asked for it (issue #24): that step's checklist is the one this run answers.
    if (typeof body.step === "number" && Number.isInteger(body.step) && body.step > 0) result.step = body.step;
    await ctx.store.saveResults(missionId, revision.n, { bench: [...(revision.results.bench ?? []), result] });
    ctx.debug.event(missionId, "bench", "bench run evaluated", { runId: result.runId, verdict: result.verdict, kind: result.kind, revision: revision.n });
    await ctx.db.insert(runs).values({ id: result.runId, missionId, revision: revision.n, kind: result.kind, result: JSON.stringify(result), createdAt: new Date() });
    const virtual = result.runId.startsWith("virtual-");
    await ctx.store.appendEvent({
      missionId,
      channel: "web",
      actor: actorFor(res, ctx),
      kind: "bench.run",
      text: virtual && result.kind === "selftest" ? `Virtual board self-test: ${result.verdict} (practice run)` : `Bench ${result.kind}: ${result.verdict}`,
      revision: revision.n,
      data: result,
    });
    // A build-step checkpoint (a subset of the plan) never moves the mission: only a run of the whole plan verifies it.
    if (!virtual && plan === serverPlan) {
      const phase = await ctx.machine.phase(missionId);
      if (body.kind === "selftest" && (phase === "ASSEMBLE" || phase === "DEBUG")) {
        await ctx.machine.send(missionId, { type: "VERIFY_STARTED" });
      }
      await ctx.machine.send(missionId, result.verdict === "pass" ? { type: "VERIFY_PASSED" } : { type: "VERIFY_FAILED" });
    }
    res.json(result);
  });
  router.post("/missions/:id/photo", upload.single("photo"), async (req, res) => {
    const missionId = String(req.params.id);
    if (!req.file) throw httpError(400, "PHOTO_REQUIRED", "multipart field photo is required");
    const step = parsePositiveInt(req.body.step ?? req.query.step);
    let jpeg: Buffer;
    try {
      let input = new Uint8Array(req.file.buffer);
      if (req.file.mimetype === "image/heic" || req.file.mimetype === "image/heif" || /\.hei[cf]$/i.test(req.file.originalname)) {
        input = new Uint8Array(await heifToJpeg(input));
      }
      jpeg = await sharp(input).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch {
      throw httpError(400, "bad_image", "photo is not a valid image");
    }
    const revision = await ctx.store.getRevision(missionId);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const photo = await ctx.runtime.checkPhoto({ missionId, step, jpeg: new Uint8Array(jpeg) });
    // No credential: the photo wasn't analyzed and the answer is a labeled recorded example — never store it as a check.
    if (photo.recordedExample) return res.json(photo);
    const hash = await ctx.store.putArtifact(jpeg, "image/jpeg");
    const photos = [...(revision.results.photos ?? []), photo];
    await ctx.store.saveResults(missionId, revision.n, { photos, artifacts: { [`photo-step-${step}.jpg`]: hash } });
    await ctx.store.appendEvent({ missionId, channel: "web", actor: actorFor(res, ctx), kind: "photo.checked", text: `Photo check for step ${step}`, revision: revision.n, data: photo });
    res.json(photo);
  });
  router.get("/debug/missions/:id/log", async (req, res) => {
    if (!ctx.lanGuard.isLoopback(req)) throw httpError(403, "lan_loopback_required", "This endpoint is available on the ViBread laptop only");
    res.json({ lines: ctx.debug.tail(String(req.params.id), typeof req.query.tail === "string" ? Number(req.query.tail) : 500) });
  });
  router.get("/debug/server-log", async (req, res) => {
    if (!ctx.lanGuard.isLoopback(req)) throw httpError(403, "lan_loopback_required", "This endpoint is available on the ViBread laptop only");
    res.json({ lines: ctx.debug.tail(null, typeof req.query.tail === "string" ? Number(req.query.tail) : 500) });
  });
  router.post("/debug/client-errors", async (req, res) => {
    const body = (req.body ?? {}) as { message?: unknown; stack?: unknown; url?: unknown; userAgent?: unknown; missionId?: unknown; componentStack?: unknown };
    if (typeof body.message !== "string" || body.message.length > 8000) throw httpError(400, "INVALID_CLIENT_ERROR", "message is required");
    ctx.debug.event(typeof body.missionId === "string" ? body.missionId : null, "client", body.message, body);
    res.status(204).send();
  });
  router.get("/lan/devices", async (req, res) => {
    if (!ctx.lanGuard.isLoopback(req)) throw httpError(403, "lan_loopback_required", "This endpoint is available on the ViBread laptop only");
    res.json({ devices: ctx.lanGuard.listDevices() });
  });
  router.post("/lan/unpair-all", async (req, res) => {
    if (!ctx.lanGuard.isLoopback(req)) throw httpError(403, "lan_loopback_required", "This endpoint is available on the ViBread laptop only");
    ctx.lanGuard.unpairAll();
    res.json({ ok: true });
  });
  router.get("/phone/missions", async (_req, res) => {
    const missions = await ctx.store.listMissions("operator");
    const result: { id: string; title: string; currentStep: number }[] = [];
    for (const mission of missions) {
      if (mission.releasedRevision === undefined) continue;
      try {
        const build = await ctx.missions.build(mission.id);
        result.push({ id: mission.id, title: mission.title, currentStep: build.current });
      } catch {
        result.push({ id: mission.id, title: mission.title, currentStep: 1 });
      }
    }
    res.json(result);
  });
  router.get("/connections", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json({
      imessage: { linked: Boolean(await ctx.links.handleForUser(user.id)), handle: await ctx.links.handleForUser(user.id), capcomNumber: ctx.capcom.number() },
      claudeCode: { tokens: await ctx.tokens.list(user.id) },
      mcpUrl: `${ctx.config.publicUrl}/mcp`,
      phoneUrl: ctx.config.phoneUrl,
      ...(ctx.lanGuard.phonePairQuery(req) ? { phonePairQuery: ctx.lanGuard.phonePairQuery(req) } : {}),
      claude: await ctx.claudeAccounts.view(user.id),
    });
  });
  router.post("/connections/tokens", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = (req.body ?? {}) as { scopes?: unknown; ttlMinutes?: unknown };
    if (!Array.isArray(body.scopes) || body.scopes.some((scope) => typeof scope !== "string")) throw httpError(400, "INVALID_SCOPES", "scopes must be strings");
    const scopes = body.scopes as string[];
    const allowed = ["circuits:read", "circuits:write", "bench:request"];
    if (scopes.some((scope) => !allowed.includes(scope))) throw httpError(400, "INVALID_SCOPES", "unsupported scope");
    const token = await ctx.tokens.mint({ userId: user.id, scopes, ttlMinutes: typeof body.ttlMinutes === "number" ? body.ttlMinutes : 60 });
    const mcpUrl = `${ctx.config.publicUrl}/mcp`;
    res.status(201).json({ ...token, scopes, command: `claude mcp add --transport http vibread ${mcpUrl} --header "Authorization: Bearer ${token.token}"` });
  });
  router.delete("/connections/tokens/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    await ctx.tokens.revoke(String(req.params.id), user.id);
    res.json({ ok: true });
  });
  router.post("/connections/imessage/code", async (_req, res) => {
    const user = actorUser(res, ctx);
    const code = await ctx.links.createCode(user.id);
    const number = ctx.capcom.number();
    const link = number ? `sms:${number}?body=${encodeURIComponent(code.code)}` : undefined;
    res.status(201).json({ ...code, capcomNumber: number, link });
  });
  // CAPCOM settings: linked handle, provider state (and what to set when it's off), notification prefs, test message.
  const imessageSettings = async (req: Request, userId: string) => {
    const handle = await ctx.links.handleForUser(userId);
    return { ...ctx.capcom.status(), linked: Boolean(handle), ...(handle ? { handle } : {}), prefs: ctx.capcom.prefs.get(userId), canEditPhoton: ctx.lanGuard.isLoopback(req) };
  };
  router.get("/connections/imessage/settings", async (req, res) => {
    res.json(await imessageSettings(req, actorUser(res, ctx).id));
  });
  router.patch("/connections/imessage/settings", async (req, res) => {
    const user = actorUser(res, ctx);
    ctx.capcom.prefs.save(user.id, mergeCapcomPrefs(ctx.capcom.prefs.get(user.id), req.body));
    res.json(await imessageSettings(req, user.id));
  });
  router.post("/connections/imessage/test", async (_req, res) => {
    await ctx.capcom.sendTest(actorUser(res, ctx).id);
    res.json({ ok: true });
  });
  // Photon credentials are server configuration: only from the ViBread computer itself; the secret is never returned.
  router.patch("/connections/imessage/photon", async (req, res) => {
    const user = actorUser(res, ctx);
    if (!ctx.lanGuard.isLoopback(req)) throw httpError(403, "lan_loopback_required", "Photon settings can only be changed on the ViBread computer");
    const body = (req.body ?? {}) as PhotonSettings;
    await ctx.capcom.savePhoton({ projectId: body.projectId, projectSecret: body.projectSecret, number: body.number });
    res.json(await imessageSettings(req, user.id));
  });
  // PLAN item 16 — connect your Claude account (pi-ai's Anthropic sign-in or an API key; see src/claude/accounts.ts).
  router.post("/connections/claude/start", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.status(201).json(await ctx.claudeAccounts.start(user.id));
  });
  router.post("/connections/claude/complete", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { loginId?: unknown; code?: unknown };
    if (typeof body.loginId !== "string" || typeof body.code !== "string") throw httpError(400, "INVALID_REQUEST", "loginId and code are required");
    res.json(await ctx.claudeAccounts.complete(user.id, body.loginId, body.code));
  });
  router.post("/connections/claude/cancel", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { loginId?: unknown };
    if (typeof body.loginId === "string") await ctx.claudeAccounts.cancel(user.id, body.loginId);
    res.json(await ctx.claudeAccounts.view(user.id));
  });
  router.post("/connections/claude/key", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = (req.body ?? {}) as { key?: unknown };
    if (typeof body.key !== "string") throw httpError(400, "INVALID_REQUEST", "key is required");
    res.json(await ctx.claudeAccounts.saveApiKey(user.id, body.key));
  });
  router.delete("/connections/claude", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.claudeAccounts.disconnect(user.id));
  });
  app.use("/api", router);
}

function sqlApprovalBroker(ctx: AppContext): SqlApprovalBroker {
  return ctx.broker as SqlApprovalBroker;
}

/**
 * The latest bench run that covered the revision's whole self-test plan. A build-step checkpoint runs a few of the
 * plan's tests (issues #21, #24); it must not stand in for the full self-test that completes a mission, unlocks the app
 * flash, or supplies the light-sensor calibration.
 */
function latestFullBenchRun(revision: Revision | null | undefined): NonNullable<RevisionResults["bench"]>[number] | undefined {
  const planned = revision?.results.selftest?.tests;
  return revision?.results.bench?.findLast((run) => !planned || planned.every((test) => run.results.some((result) => result.test === test)));
}

async function currentRevisionForBench(ctx: AppContext, missionId: string): Promise<{ revision: number | null; hash: string }> {
  const mission = await ctx.store.getMission(missionId);
  if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
  if (mission.releasedRevision === undefined) return { revision: null, hash: "none" };
  const revision = await ctx.store.getRevision(missionId, mission.releasedRevision);
  if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "released revision not found");
  return { revision: revision.n, hash: revision.hash };
}

function userFromLocals(res: Response): WebUser | undefined {
  const user = res.locals.user as WebUser | undefined;
  if (!user || typeof user.id !== "string" || typeof user.name !== "string") return undefined;
  return user;
}

function actorUser(res: Response, ctx: AppContext): WebUser {
  const user = userFromLocals(res);
  if (user) return user;
  if (ctx.config.singleOperator) return { id: "operator", name: "Operator" };
  throw httpError(401, "UNAUTHORIZED", "sign in required");
}
function actorFor(res: Response, ctx: AppContext): Actor {
  const user = actorUser(res, ctx);
  return { kind: "human", id: user.id, name: user.name, channel: "web" };
}

function artifactUrl(missionId: string, n: number, key: string): string {
  return `/api/missions/${encodeURIComponent(missionId)}/revisions/${n}/artifacts/${encodeURIComponent(key)}`;
}

function toRevisionSummary(revision: Revision): unknown {
  const verdicts: Record<string, string> = {};
  for (const report of revision.results.reports) verdicts[report.console] = report.verdict;
  return { n: revision.n, hash: revision.hash, note: revision.note, author: revision.author, createdAt: revision.createdAt, verdicts };
}

function toSummary(mission: Mission): unknown {
  return {
    id: mission.id,
    title: mission.title,
    brief: mission.brief,
    phase: mission.phase,
    currentRevision: mission.currentRevision,
    releasedRevision: mission.releasedRevision,
    updatedAt: mission.updatedAt,
  };
}


function parsePositiveInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, "INVALID_NUMBER", "expected a positive integer");
  return n;
}
function parseNonNegativeInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) throw httpError(400, "INVALID_NUMBER", "expected a non-negative integer");
  return n;
}
interface ScanFailure {
  status: number;
  code: string;
  message: string;
  retryAfter?: string;
}

/** An uploaded photo (JPEG, PNG, HEIC from an iPhone) as an upright JPEG within the vision tier's long edge. */
async function uploadedJpeg(file: Express.Multer.File): Promise<Buffer> {
  try {
    let input = new Uint8Array(file.buffer);
    if (file.mimetype === "image/heic" || file.mimetype === "image/heif" || /\.hei[cf]$/i.test(file.originalname)) input = new Uint8Array(await heifToJpeg(input));
    return await sharp(input).rotate().resize({ width: 2576, height: 2576, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch {
    throw httpError(400, "bad_image", "photo is not a valid image");
  }
}

function scanFailure(error: unknown): ScanFailure {
  const value = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const rawCode = typeof value.code === "string" ? value.code : "";
  const rawStatus = typeof value.status === "number" ? value.status : typeof value.statusCode === "number" ? value.statusCode : 0;
  const text = error instanceof Error ? error.message : String(error);
  const rateLimited = rawStatus === 429 || /rate[_ -]?limit|too many requests/i.test(`${rawCode} ${text}`);
  const notConnected = rawCode === "claude_not_connected" || rawStatus === 503;
  const retryRaw = value.retryAfter ?? (typeof value.headers === "object" && value.headers !== null ? (value.headers as Record<string, unknown>)["retry-after"] : undefined);
  const retryAfter = typeof retryRaw === "number" ? new Date(Date.now() + (retryRaw < 1_000_000_000 ? retryRaw * 1000 : retryRaw)).toISOString() : typeof retryRaw === "string" && !Number.isNaN(Date.parse(retryRaw)) ? new Date(retryRaw).toISOString() : undefined;
  if (rateLimited) return { status: 429, code: "claude_rate_limited", message: "Claude is rate limited. Try again later.", ...(retryAfter ? { retryAfter } : {}) };
  if (notConnected) return { status: 503, code: "claude_not_connected", message: "Claude is not connected. Connect Claude in Settings and try again." };
  return { status: 502, code: "claude_error", message: "The scan service could not analyze the photos. Try again." };
}

interface HttpError extends Error {
  status: number;
  code: string;
}

function httpError(status: number, code: string, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  error.code = code;
  return error;
}
