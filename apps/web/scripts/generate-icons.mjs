import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = resolve(root, "public/icon.svg");
const output = resolve(root, "public");

await mkdir(output, { recursive: true });
await sharp(source).resize(192, 192).png().toFile(resolve(output, "icon-192.png"));
await sharp(source).resize(512, 512).png().toFile(resolve(output, "icon-512.png"));
await sharp(source)
  .resize(420, 420)
  .extend({ top: 46, bottom: 46, left: 46, right: 46, background: "#0E1719" })
  .png()
  .toFile(resolve(output, "icon-maskable-512.png"));
await sharp(source).resize(180, 180).png().toFile(resolve(output, "apple-touch-icon.png"));

console.log("Generated ViBread PWA icons in", dirname(resolve(output, "icon-192.png")));
