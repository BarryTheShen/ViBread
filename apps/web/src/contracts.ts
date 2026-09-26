/**
 * Redesign contracts shared by the UI slices (docs/ui-redesign-plan.md §3, §4, §8). Types only: each component lives in
 * its owner's folder and implements these props exactly, so slices can be built in parallel.
 *
 * Owners: shell/* (S1 ShellTheme) · pages/NewMissionPage + pages/MissionPage + chat/* (S2 ChatUI) · workspace/* (S3
 * WebWorkspace) · inventory/* (S4 InventoryUI) · bench/* + build/* (S6).
 */
import type { InventoryItem, MissionDetail, PermissionMode, TimelineEvent } from "@vibread/core";

/** Views of the right-hand artifact panel (§3.2). */
export const PANEL_VIEWS = [
  "parts",
  "schematic",
  "steps",
  "code",
  "tests",
  "tryit",
  "replay",
  "checks",
  "telemetry",
  "diagnosis",
  "photos",
] as const;
export type PanelView = (typeof PANEL_VIEWS)[number];

/** What the header's next-step button shows (§2). Derived from MissionDetail + BuildState by S3's `nextStepOf`. */
export type NextStep =
  | { kind: "working" }
  | { kind: "go" }
  | { kind: "build"; done: number; total: number }
  | { kind: "bench" }
  | { kind: "bench-real" }
  | { kind: "confirm" }
  | { kind: "done" };

/**
 * Mission-level UI state shared by the chat (S2) and the panel/header (S3). MissionPage (S2) creates it; timeline rows
 * and header buttons call `openPanel` to show details.
 */
export interface MissionShellValue {
  missionId: string;
  detail: MissionDetail;
  panel: { open: boolean; view: PanelView; revision?: number };
  openPanel(view: PanelView, options?: { revision?: number; console?: string }): void;
  closePanel(): void;
}

/** S3 workspace/ArtifactPanel.tsx */
export interface ArtifactPanelProps {
  missionId: string;
  detail: MissionDetail;
  view: PanelView;
  revision?: number;
  /** Console id to focus in the Checks view (EECOM…RETRO). */
  console?: string;
  onViewChange(view: PanelView): void;
  onRevisionChange(revision: number): void;
  onClose(): void;
}

/** S3 workspace/MissionHeader.tsx: title, five status dots, next-step button, ⋯ menu. */
export interface MissionHeaderProps {
  missionId: string;
  detail: MissionDetail;
  onOpenPanel: MissionShellValue["openPanel"];
}

/** S2 chat/Composer.tsx: the chat box (new mission and replies). */
export interface ComposerProps {
  placeholder: string;
  mode: PermissionMode;
  onModeChange(mode: PermissionMode): void;
  /** "Parts: all inventory (23)" chip; omitted in a running mission. */
  parts?: { label: string; onClick(): void };
  running: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSend(text: string): void;
  onStop(): void;
}

/** S2 chat/TimelineRow.tsx: one timeline event rendered inside the chat as a one-line collapsible row. */
export interface TimelineRowProps {
  event: TimelineEvent;
  onOpenPanel: MissionShellValue["openPanel"];
}

/** S4 inventory/PartsChip.tsx (used by S2's composer) and inventory/PartsView.tsx (used by S3's panel "parts" view). */
export interface PartsViewProps {
  missionId: string;
  /** Parts the mission may use (Mission.inventory) … */
  missionParts: InventoryItem[];
  /** … and the design version to compare against (need vs have). */
  revision?: number;
}
