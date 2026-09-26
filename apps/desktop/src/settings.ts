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

/**
 * Linux desktops without a keyring (no gnome-keyring/KWallet: minimal window managers, kiosks) leave safeStorage on
 * its 'basic_text' backend, which refuses to encrypt until told to use Chromium's fixed obfuscation key. The key is
 * then only obfuscated in settings.json (mode 0600); apiKeyStatus() reports that so the UI can say so.
 */
function storageReady(): boolean {
  if (safeStorage.isEncryptionAvailable()) return true;
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    safeStorage.setUsePlainTextEncryption(true);
    return safeStorage.isEncryptionAvailable();
  }
  return false;
}

export function getApiKey(): string | undefined {
  const stored = load().anthropicApiKey;
  if (!stored || !storageReady()) return undefined;
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
    if (!storageReady()) throw new Error("This system has no credential store available (safeStorage).");
    settings.anthropicApiKey = safeStorage.encryptString(key).toString("base64");
  }
  save(settings);
}

export function apiKeyStatus(): { set: boolean; canStore: boolean; keyring: boolean } {
  const canStore = storageReady();
  return {
    set: getApiKey() !== undefined,
    canStore,
    keyring: canStore && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"),
  };
}
