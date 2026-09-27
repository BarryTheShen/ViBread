import multer from "multer";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { AppContext } from "../context.js";
import { SqlMissionStore } from "../store/missions.js";
import {
  createProjectFileService,
  PROJECT_MAX_UPLOAD_BYTES,
  ProjectFileError,
  type ProjectFileService,
} from "../services/project-file.js";

interface WebUser {
  id: string;
  name: string;
}

function projectError(status: number, code: string, message: string): ProjectFileError {
  return new ProjectFileError(status, code, message);
}

async function currentUser(ctx: AppContext, res: Response): Promise<WebUser> {
  const user = res.locals.user as { id?: unknown; name?: unknown } | undefined;
  if (typeof user?.id === "string" && user.id) return { id: user.id, name: typeof user.name === "string" ? user.name : user.id };
  if (ctx.config.singleOperator) {
    const operator = await ctx.operator();
    return operator;
  }
  throw projectError(401, "UNAUTHORIZED", "sign in required");
}

function projectUpload(): RequestHandler {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: PROJECT_MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldSize: 1_024 } });
  return (req: Request, res: Response, next: NextFunction): void => {
    upload.single("file")(req, res, (error: unknown) => {
      if (!error) {
        next();
        return;
      }
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "LIMIT_FILE_SIZE") {
        next(projectError(413, "PROJECT_TOO_LARGE", "This project file is too large (maximum 25 MB)"));
        return;
      }
      next(projectError(400, "INVALID_PROJECT", "This file isn't a ViBread project"));
    });
  };
}

/** The project-file service wired to this server's stores; shared by the export/import and duplicate routes. */
export function projectFileService(ctx: AppContext): ProjectFileService {
  return createProjectFileService({
    store: ctx.store,
    messages: ctx.messages,
    machine: ctx.machine,
    pipeline: ctx.runtime.pipeline,
    deleteMission: (missionId) => {
      if (ctx.store instanceof SqlMissionStore) ctx.store.deleteMission(missionId);
    },
    log: ctx.log,
  });
}

/** Mounts portable mission project export/import before the parameterised mission-owner middleware. */
export function mountProjectFileRoutes(app: Express, ctx: AppContext): void {
  const service = projectFileService(ctx);

  app.get("/api/missions/:id/project", async (req, res) => {
    const user = await currentUser(ctx, res);
    const missionId = String(req.params.id);
    const mission = await ctx.store.getMission(missionId);
    if (!mission || mission.ownerId !== user.id) throw projectError(404, "MISSION_NOT_FOUND", "mission not found");
    const project = await service.export(missionId);
    res.setHeader("Content-Type", "application/zip");
    const asciiName = project.fileName.replace(/[^\x20-\x7e]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(project.fileName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(Buffer.from(project.bytes));
  });

  const requireImportUser: RequestHandler = (_req, res, next) => {
    void currentUser(ctx, res).then((user) => {
      res.locals.projectUser = user;
      next();
    }, next);
  };
  app.post("/api/missions/import", requireImportUser, projectUpload(), async (req, res) => {
    const user = res.locals.projectUser as WebUser;
    if (!req.file?.buffer?.byteLength) throw projectError(400, "INVALID_PROJECT", "This file isn't a ViBread project");
    const result = await service.import({ bytes: new Uint8Array(req.file.buffer), ownerId: user.id, fileName: req.file.originalname });
    res.status(201).json(result);
  });
}
