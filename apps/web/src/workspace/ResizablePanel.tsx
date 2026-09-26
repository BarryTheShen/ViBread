import Box from "@mui/material/Box";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "vibread:panel-width";
const DEFAULT_WIDTH = 560;
export const MIN_PANEL_WIDTH = 380;
const MAX_PANEL_WIDTH = 1400;
/** The chat beside the panel keeps at least this much room. */
const CHAT_MIN_WIDTH = 380;
const KEY_STEP = 24;

/** Largest panel width that still leaves the chat usable, given the row the panel sits in. */
export function maxPanelWidth(rowWidth: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, rowWidth - CHAT_MIN_WIDTH));
}

export function clampPanelWidth(width: number, rowWidth: number): number {
  return Math.round(Math.min(maxPanelWidth(rowWidth), Math.max(MIN_PANEL_WIDTH, width)));
}

function storedWidth(): number {
  const value = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WIDTH;
}

/**
 * The mission's right-hand panel with a drag handle on its left edge (plan issue #11). Drag, or focus the handle and use
 * ←/→ (Shift = bigger steps, Home/End = narrowest/widest); double-click resets. The width is remembered per browser.
 */
export function ResizablePanel({ label, children }: { label: string; children: ReactNode }) {
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [width, setWidth] = useState(storedWidth);
  const [rowWidth, setRowWidth] = useState(0);

  // Follow the row's size (window resize, sidebar collapse) so the panel never squeezes the chat below its minimum.
  useEffect(() => {
    const row = panelRef.current?.parentElement;
    if (!row) return;
    const observer = new ResizeObserver(() => setRowWidth(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const shown = rowWidth > 0 ? clampPanelWidth(width, rowWidth) : width;
  const commit = useCallback(
    (next: number) => {
      const clamped = rowWidth > 0 ? clampPanelWidth(next, rowWidth) : next;
      setWidth(clamped);
      localStorage.setItem(STORAGE_KEY, String(clamped));
    },
    [rowWidth],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: shown };
  };
  // The handle is on the panel's left edge: moving left widens the panel. Width comes from the event, not state,
  // so the final pointerup never commits a value one move behind.
  const draggedWidth = (e: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    return active && active.pointerId === e.pointerId ? active.startWidth + active.startX - e.clientX : undefined;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const next = draggedWidth(e);
    if (next !== undefined) setWidth(clampPanelWidth(next, rowWidth || Number.MAX_SAFE_INTEGER));
  };
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const next = draggedWidth(e);
    if (next === undefined) return;
    drag.current = null;
    commit(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next =
      e.key === "ArrowLeft" ? shown + step : e.key === "ArrowRight" ? shown - step : e.key === "Home" ? MIN_PANEL_WIDTH : e.key === "End" ? MAX_PANEL_WIDTH : undefined;
    if (next === undefined) return;
    e.preventDefault();
    commit(next);
  };

  return (
    <Box
      ref={panelRef}
      component="aside"
      aria-label={label}
      sx={{ position: "relative", flex: "0 0 auto", width: shown, borderLeft: 1, borderColor: "divider", bgcolor: "background.paper", minHeight: 0 }}
    >
      <Box
        role="separator"
        tabIndex={0}
        aria-label="Resize the panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={rowWidth > 0 ? maxPanelWidth(rowWidth) : MAX_PANEL_WIDTH}
        aria-valuenow={shown}
        aria-valuetext={`${shown} pixels wide`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(DEFAULT_WIDTH)}
        sx={{
          position: "absolute",
          zIndex: 2,
          top: 0,
          bottom: 0,
          left: -6,
          width: 12,
          cursor: "col-resize",
          touchAction: "none",
          "&::after": { content: '""', position: "absolute", top: 0, bottom: 0, left: 5, width: 2, bgcolor: "transparent", transition: "background-color 120ms" },
          "&:hover::after, &:focus-visible::after, &:active::after": { bgcolor: "primary.main" },
        }}
      />
      {children}
    </Box>
  );
}
