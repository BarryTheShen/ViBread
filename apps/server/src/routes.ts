import { Router, type Express, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { heifToJpeg } from "heif2jpeg";
import type {
  Actor,
  BenchRunRequest,
  CompileResult,
  Mission,
  PermissionMode,
  ReleaseRequest,
  Revision,
  RevisionResults,
} from "@vibread/core";
import { MODULES } from "@vibread/core";
import { applyCalibration, compileBenchFirmware, compileSketch } from "@vibread/firmware";
import { calibrationMacros, evaluateRun, planSelfTest } from "@vibread/bench";
import { loadFaultDictionary } from "@vibread/tools";
import { runs } from "./db/schema.js";
import type { AppContext } from "./context.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

export function mountApi(app: Express, ctx: AppContext): void {
  const router = Router();
  router.get("/me", async (req, res) => {
    const user = actorUser(res, ctx);
    res.json({ user, auth: ctx.config.singleOperator ? "single-operator" : "google" });
  });
  router.get("/modules", (_req, res) => {
    res.json(Object.values(MODULES).map((module) => ({ key: module.key, name: module.name, description: module.description, category: module.category })));
  });
  router.get("/missions", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.missions.list(user.id));
  });
  router.post("/missions", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { brief?: unknown; inventory?: unknown; mode?: unknown; title?: unknown };
    if (typeof body.brief !== "string" || body.brief.trim().length === 0 || !Array.isArray(body.inventory)) {
      throw httpError(400, "INVALID_REQUEST", "brief and inventory are required");
    }
    const mission = await ctx.missions.create({
      brief: body.brief,
      inventory: body.inventory as Mission["inventory"],
      mode: isPermissionMode(body.mode) ? body.mode : undefined,
      title: typeof body.title === "string" ? body.title : undefined,
      owner: { kind: "human", id: user.id, name: user.name, channel: "web" },
    });
    res.status(201).json(toSummary(mission));
  });
  router.get("/missions/:id", async (req, res) => {
    res.json(await ctx.missions.detail(String(req.params.id)));
  });
  router.patch("/missions/:id", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { mode?: unknown };
    if (!isPermissionMode(body.mode)) throw httpError(400, "INVALID_MODE", "mode is invalid");
    const mission = await ctx.missions.setMode(String(req.params.id), body.mode, { kind: "human", id: user.id, name: user.name, channel: "web" });
    res.json(toSummary(mission));
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
    res.json({ n: revision.n, hash: revision.hash, circuit: revision.circuit, suite: revision.suite, results: revision.results, artifactUrls });
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
    const body = req.body as Partial<ReleaseRequest>;
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
  router.post("/missions/:id/build/step", async (req, res) => {
    const missionId = String(req.params.id);
    const n = parsePositiveInt((req.body as { n?: unknown }).n);
    const before = await ctx.missions.build(missionId);
    await ctx.store.appendEvent({
      missionId,
      channel: "web",
      actor: actorFor(res, ctx),
      kind: "build.step",
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
  router.post("/missions/:id/bench/firmware", async (req, res) => {
    const missionId = String(req.params.id);
    const body = req.body as { kind?: unknown };
    if (body.kind !== "bench" && body.kind !== "app") throw httpError(400, "INVALID_KIND", "kind must be bench or app");
    const mission = await ctx.store.getMission(missionId);
    if (!mission) throw httpError(404, "MISSION_NOT_FOUND", "mission not found");
    const revisionNumber = mission.releasedRevision ?? mission.currentRevision;
    const revision = revisionNumber === undefined ? null : await ctx.store.getRevision(missionId, revisionNumber);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const key = body.kind === "bench" ? "bench.hex" : "app.hex";
    const cachedHash = revision.results.artifacts[key];
    if (cachedHash) {
      const cached = await ctx.store.getArtifact(cachedHash);
      if (cached) return res.json({ hex: Buffer.from(cached.data).toString("utf8"), design: revision.hash, ...(body.kind === "bench" ? { plan: revision.results.selftest } : {}) });
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
      const { hex: _hex, elfPath: _elfPath, ...withoutBinary } = compile;
      await ctx.store.saveResults(missionId, revision.n, { compile: withoutBinary, ...(body.kind === "bench" && plan ? { selftest: plan } : {}) });
      return res.status(422).json({ error: { code: "COMPILE_FAILED", message: compile.log || "firmware compilation failed" }, diagnostics: compile.diagnostics });
    }
    const artifactHash = await ctx.store.putArtifact(compile.hex, "text/plain; charset=utf-8");
    const { hex: _hex, elfPath: _elfPath, ...withoutBinary } = compile;
    const resultPatch: Partial<RevisionResults> = {
      compile: withoutBinary,
      artifacts: { [key]: artifactHash },
      ...(body.kind === "bench" && plan ? { selftest: plan } : {}),
    };
    await ctx.store.saveResults(missionId, revision.n, resultPatch);
    res.json({ hex: compile.hex, design: revision.hash, ...(body.kind === "bench" ? { plan } : {}) });
  });
  router.post("/missions/:id/bench/runs", async (req, res) => {
    const missionId = String(req.params.id);
    const body = req.body as BenchRunRequest;
    const revision = await ctx.store.getRevision(missionId, body.revision);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    // PLAN item 14: rank single-fault mutants when the background fault dictionary (faults.json) is ready.
    const faultDictionary = await loadFaultDictionary(ctx.store, revision.results.artifacts);
    const result = await evaluateRun({
      circuit: revision.circuit,
      layout: revision.results.layout,
      plan: body.plan,
      lines: body.lines,
      answers: body.answers,
      kind: body.kind,
      revision: revision.n,
      runId: `run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...(faultDictionary ? { faultDictionary } : {}),
    });
    await ctx.store.saveResults(missionId, revision.n, { bench: [...(revision.results.bench ?? []), result] });
    await ctx.db.insert(runs).values({ id: result.runId, missionId, revision: revision.n, kind: result.kind, result: JSON.stringify(result), createdAt: new Date() });
    await ctx.store.appendEvent({
      missionId,
      channel: "web",
      actor: actorFor(res, ctx),
      kind: "bench.run",
      text: `Bench ${result.kind}: ${result.verdict}`,
      revision: revision.n,
      data: result,
    });
    const phase = await ctx.machine.phase(missionId);
    if (body.kind === "selftest" && (phase === "ASSEMBLE" || phase === "DEBUG")) {
      await ctx.machine.send(missionId, { type: "VERIFY_STARTED" });
    }
    await ctx.machine.send(missionId, result.verdict === "pass" ? { type: "VERIFY_PASSED" } : { type: "VERIFY_FAILED" });
    res.json(result);
  });
  router.post("/missions/:id/photo", upload.single("photo"), async (req, res) => {
    const missionId = String(req.params.id);
    if (!req.file) throw httpError(400, "PHOTO_REQUIRED", "multipart field photo is required");
    const step = parsePositiveInt(req.body.step ?? req.query.step);
    let input = new Uint8Array(req.file.buffer);
    if (req.file.mimetype === "image/heic" || req.file.mimetype === "image/heif" || /\.hei[cf]$/i.test(req.file.originalname)) {
      input = new Uint8Array(await heifToJpeg(input));
    }
    const jpeg = await sharp(input).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const revision = await ctx.store.getRevision(missionId);
    if (!revision) throw httpError(404, "REVISION_NOT_FOUND", "revision not found");
    const photo = await ctx.runtime.checkPhoto({ missionId, step, jpeg: new Uint8Array(jpeg) });
    const hash = await ctx.store.putArtifact(jpeg, "image/jpeg");
    const photos = [...(revision.results.photos ?? []), photo];
    await ctx.store.saveResults(missionId, revision.n, { photos, artifacts: { [`photo-step-${step}.jpg`]: hash } });
    await ctx.store.appendEvent({ missionId, channel: "web", actor: actorFor(res, ctx), kind: "photo.checked", text: `Photo check for step ${step}`, revision: revision.n, data: photo });
    res.json(photo);
  });
  router.get("/connections", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.json({
      imessage: { linked: Boolean(await ctx.links.handleForUser(user.id)), handle: await ctx.links.handleForUser(user.id), capcomNumber: ctx.config.capcom.number },
      claudeCode: { tokens: await ctx.tokens.list(user.id) },
      mcpUrl: `${ctx.config.publicUrl}/mcp`,
      claude: await ctx.claudeAccounts.view(user.id),
    });
  });
  router.post("/connections/tokens", async (req, res) => {
    const user = actorUser(res, ctx);
    const body = req.body as { scopes?: unknown; ttlMinutes?: unknown };
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
    const link = ctx.config.capcom.number ? `sms:${ctx.config.capcom.number}?body=${encodeURIComponent(code.code)}` : undefined;
    res.status(201).json({ ...code, capcomNumber: ctx.config.capcom.number, link });
  });
  // PLAN item 16 — connect your Claude account (oh-my-pi auth broker + gateway; see src/claude/accounts.ts).
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
  router.delete("/connections/claude", async (_req, res) => {
    const user = actorUser(res, ctx);
    res.json(await ctx.claudeAccounts.disconnect(user.id));
  });
  app.use("/api", router);
}

function actorUser(res: Response, ctx: AppContext): { id: string; name: string; email?: string; image?: string } {
  const user = res.locals.user as { id: string; name: string; email?: string; image?: string } | undefined;
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
    mode: mission.mode,
    phase: mission.phase,
    currentRevision: mission.currentRevision,
    releasedRevision: mission.releasedRevision,
    updatedAt: mission.updatedAt,
  };
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "ask" || value === "review" || value === "autopilot";
}

function parsePositiveInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, "INVALID_NUMBER", "expected a positive integer");
  return n;
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
