export declare const CLI_VERSION: string;
export declare const AVR_CORE: string;
export declare const ARDUINOJSON: string;
export interface ToolchainPaths {
  cli: string;
  config: string;
}
export interface ToolchainProgress {
  step: string;
  message: string;
  fraction?: number;
}
export declare function toolchainPaths(dir: string, platform?: NodeJS.Platform): ToolchainPaths;
export declare function installToolchain(options: {
  dir: string;
  onProgress?: (event: ToolchainProgress) => void;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<ToolchainPaths>;
