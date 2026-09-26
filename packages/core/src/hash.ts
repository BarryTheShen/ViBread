import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";

/** RFC 8785 canonical JSON: the same value always serializes to the same string. */
export function canonicalJson(value: unknown): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("value is not JSON-serializable");
  return text;
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === "string" ? utf8ToBytes(input) : input));
}

/** Content hash of any JSON value (64 hex chars). Revision, layout, and artifact hashes all use this. */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** 8-hex design id printed in firmware banners and shown in the UI. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
