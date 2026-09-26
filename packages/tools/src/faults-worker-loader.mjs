// Source-mode worker entry: workspace packages ship TypeScript, so the worker loads its entry through tsx.
import { tsImport } from "tsx/esm/api";
await tsImport("./faults-worker.ts", import.meta.url);
