/**
 * Connection-table fallback for the Schematic tab: shown instead of a drawing whenever the drawing fails
 * `checkSchematicSvg`, so the user never sees a misleading picture. One row per connected part pin.
 */
import { BOARD_PART, MODULES, modulePins, pinKey, type Circuit, type Net } from "@vibread/core";
import { checkSchematicSvg, textWidth, type SchematicIssue } from "./check.js";

export interface ConnectionRow {
  /** "LED1 (Quick mode light) · A anode (+, long leg)" */
  pin: string;
  /** "Arduino D4", "GND", or the other part pins on the net. */
  connectsTo: string;
  net: string;
}

function describeNet(net: Net, self: string, circuit: Circuit): string {
  const board = net.pins.filter((ref) => ref.part === BOARD_PART).map((ref) => `Arduino ${ref.pin}`);
  if (net.kind !== "signal") return board.length > 0 ? `${net.id} (${board.join(", ")})` : net.id;
  if (board.length > 0) return board.join(", ");
  const others = net.pins.filter((ref) => pinKey(ref) !== self).map((ref) => {
    const part = circuit.parts.find((candidate) => candidate.id === ref.part);
    return part ? `${ref.part} · ${ref.pin}` : `${ref.part}.${ref.pin}`;
  });
  return others.join(", ");
}

/** Part · pin → Arduino pin / net, in part order then pin order. */
export function connectionRows(circuit: Circuit): ConnectionRow[] {
  const netOf = new Map<string, Net>();
  for (const net of circuit.nets) for (const ref of net.pins) netOf.set(pinKey(ref), net);
  const rows: ConnectionRow[] = [];
  for (const part of circuit.parts) {
    const name = part.label ?? MODULES[part.module].name;
    for (const pin of modulePins(part)) {
      const key = `${part.id}.${pin.id}`;
      const net = netOf.get(key);
      if (!net) continue;
      rows.push({ pin: `${part.id} (${name}) · ${pin.id}: ${pin.name}`, connectsTo: describeNet(net, key, circuit), net: net.id });
    }
  }
  return rows;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const FONT_FAMILY = "DejaVu Sans, Verdana, Arial, Helvetica, sans-serif";

/** Self-contained dark SVG table, clearly titled as a replacement for the drawing. */
export function connectionTableSvg(circuit: Circuit, reasons: string[] = []): string {
  const rows = connectionRows(circuit);
  const size = 14;
  const rowHeight = 26;
  const pad = 28;
  const gap = 32;
  const header = { pin: "Part · pin", connectsTo: "Connects to", net: "Net" };
  const columnWidth = (key: keyof ConnectionRow) => Math.max(...[header, ...rows].map((row) => textWidth(row[key], size, row === header)));
  const widths = [columnWidth("pin"), columnWidth("connectsTo"), columnWidth("net")];
  const title = `Connection table: ${circuit.title}`;
  const subtitle = "The automatic schematic drawing could not be laid out cleanly for this design, so every connection is listed instead.";
  const width = Math.ceil(Math.max(widths[0]! + widths[1]! + widths[2]! + 2 * gap, textWidth(title, 20, true), textWidth(subtitle, 13)) + 2 * pad);
  const tableTop = pad + 64;
  const height = tableTop + (rows.length + 1) * rowHeight + pad;
  const xs = [pad, pad + widths[0]! + gap, pad + widths[0]! + widths[1]! + 2 * gap];
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" data-schematic="connection-table" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT_FAMILY}">`,
    `<title>${escapeXml(title)}</title>`,
  ];
  if (reasons.length > 0) out.push(`<desc>${escapeXml(reasons.slice(0, 8).join("\n"))}</desc>`);
  out.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#0b1220"/>`);
  out.push(`<text x="${pad}" y="${pad + 18}" font-size="20" font-weight="bold" fill="#f8fafc">${escapeXml(title)}</text>`);
  out.push(`<text x="${pad}" y="${pad + 42}" font-size="13" fill="#fde68a">${escapeXml(subtitle)}</text>`);
  [header, ...rows].forEach((row, index) => {
    const y = tableTop + index * rowHeight + 18;
    if (index > 0) out.push(`<line x1="${pad}" y1="${y - 18}" x2="${width - pad}" y2="${y - 18}" stroke="#24324a" stroke-width="1"/>`);
    const bold = index === 0 ? ` font-weight="bold"` : "";
    const colors = index === 0 ? ["#a7f3d0", "#a7f3d0", "#a7f3d0"] : ["#f8fafc", "#5eead4", "#94a3b8"];
    const cells = [row.pin, row.connectsTo, row.net];
    cells.forEach((cell, column) => out.push(`<text x="${xs[column]}" y="${y}" font-size="${size}"${bold} fill="${colors[column]}">${escapeXml(cell)}</text>`));
  });
  out.push("</svg>");
  return out.join("\n");
}

/**
 * Render-time gate: the drawing when it passes every check, otherwise the connection table (with the reasons in its
 * <desc>). Never lets a misleading drawing through.
 */
export function verifiedSchematic(circuit: Circuit, drawing: string): { svg: string; issues: SchematicIssue[] } {
  const issues = checkSchematicSvg(drawing, circuit);
  if (issues.length === 0) return { svg: drawing, issues };
  return { svg: connectionTableSvg(circuit, issues.map((issue) => `${issue.code}: ${issue.message}`)), issues };
}
