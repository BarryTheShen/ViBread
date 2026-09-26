import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

interface StoredSettings {
  /** Anthropic API key encrypted with Electron safeStorage (Keychain / DPAPI / libsecret), base64. */
  anthropicApiKey?: string;
}

const file = () => join(app.getPath("userData"), "settings.json");

function load(): StoredSettings {
  if (!existsSync(file())) return {};
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as StoredSettings;
  } catch {
    return {};
  }
}

function save(settings: StoredSettings): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function getApiKey(): string | undefined {
  const stored = load().anthropicApiKey;
  if (!stored || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}

export function setApiKey(key: string | undefined): void {
  const settings = load();
  if (!key) {
    delete settings.anthropicApiKey;
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This system has no secure credential store available (safeStorage).");
    settings.anthropicApiKey = safeStorage.encryptString(key).toString("base64");
  }
  save(settings);
}

export function apiKeyStatus(): { set: boolean; secureStorage: boolean; backend?: string } {
  return {
    set: getApiKey() !== undefined,
    secureStorage: safeStorage.isEncryptionAvailable(),
    backend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : undefined,
  };
}
