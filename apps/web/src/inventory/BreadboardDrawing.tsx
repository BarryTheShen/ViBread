import Box from "@mui/material/Box";
import { BREADBOARD_PROFILES, COLUMNS, type BreadboardProfileId } from "@vibread/core";

const PITCH = 6;
const PAD = 8;
const CHANNEL = 8;
const RAIL_BAND = 16;

/**
 * A small top-down drawing of a breadboard profile for the "Your hardware" picker: its numbered rows, the a–j
 * columns either side of the channel, and its rails (none on a mini board, a visible break on split rails), drawn from
 * the profile data so it can't disagree with the allocator.
 */
export function BreadboardDrawing({ profile: id, scale = 0.75 }: { profile: BreadboardProfileId; scale?: number }) {
  const profile = BREADBOARD_PROFILES[id];
  const rails = profile.railSides.length > 0;
  const bandTop = rails ? RAIL_BAND : 4;
  const boardWidth = PAD * 2 + (profile.rows - 1) * PITCH;
  const columnY = (index: number) => bandTop + PAD + index * PITCH + (index >= 5 ? CHANNEL : 0);
  const boardHeight = columnY(9) + PAD + (rails ? RAIL_BAND : 4);
  const rowX = (row: number) => PAD + (profile.labels.rowOne === "left" ? row - 1 : profile.rows - row) * PITCH;
  const holes: string[] = [];
  for (let row = 1; row <= profile.rows; row += 1) for (let index = 0; index < COLUMNS.length; index += 1) holes.push(`M${rowX(row)} ${columnY(index)}h0.01`);
  const railLines = (y: number, plusOutside: boolean, top: boolean) => {
    const plusY = plusOutside === top ? y - 3 : y + 3;
    const minusY = plusOutside === top ? y + 3 : y - 3;
    const split = profile.railsSplit && profile.railSplitAfter !== undefined ? rowX(profile.railSplitAfter) : undefined;
    const segments = split === undefined ? [[PAD - 2, boardWidth - PAD + 2]] : [[PAD - 2, split - PITCH / 2], [split + PITCH * 1.5, boardWidth - PAD + 2]];
    return segments.flatMap(([from, to]) => [
      <line key={`p${y}${from}`} x1={from} x2={to} y1={plusY} y2={plusY} stroke="#E03131" strokeWidth={1.5} />,
      <line key={`m${y}${from}`} x1={from} x2={to} y1={minusY} y2={minusY} stroke="#3B6FD8" strokeWidth={1.5} />,
    ]);
  };
  const outside = profile.labels.redRail === "outside";
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
      role="img"
      aria-label={`${profile.name}: ${profile.rows} rows${rails ? (profile.railsSplit ? ", rails split in the middle" : ", rails on both edges") : ", no power rails"}`}
      // One scale for every profile, so a mini board looks smaller than a full-size one.
      sx={{ width: `min(100%, ${Math.round(boardWidth * scale)}px)`, height: "auto", display: "block" }}
    >
      <rect x={0.5} y={0.5} width={boardWidth - 1} height={boardHeight - 1} rx={4} fill="#EEF1F4" stroke="#B8C0C9" />
      <rect x={PAD - 3} y={columnY(4) + 2} width={boardWidth - 2 * PAD + 6} height={CHANNEL + PITCH - 4} fill="#D5DAE0" />
      {rails ? [...railLines(bandTop / 2 + 1, outside, true), ...railLines(boardHeight - RAIL_BAND / 2 - 1, outside, false)] : null}
      <path d={holes.join("")} stroke="#39414B" strokeWidth={2.4} strokeLinecap="round" />
      <text x={rowX(1)} y={bandTop + 3} fontSize={5} textAnchor="middle" fill="#3B4552">1</text>
      <text x={rowX(profile.rows)} y={bandTop + 3} fontSize={5} textAnchor="middle" fill="#3B4552">{profile.rows}</text>
    </Box>
  );
}
