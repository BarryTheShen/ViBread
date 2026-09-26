/**
 * Server SVG artifacts are inlined (the replay needs DOM access to `glow-<ID>` elements). Their text can contain
 * agent-chosen labels, so strip anything executable before inlining: scripts, foreignObject, event-handler attributes,
 * and javascript: links.
 */
export function sanitizeSvg(text: string): string {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("The drawing could not be read (not a valid SVG).");
  }
  for (const el of Array.from(root.querySelectorAll("script, foreignObject, iframe, object, embed"))) el.remove();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && value.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}
