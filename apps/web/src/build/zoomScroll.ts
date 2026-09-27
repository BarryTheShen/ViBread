/** Where the viewer is looking in a scrollable picture, as a fraction (0–1) of the picture's width and height. */
export interface ViewCentre {
  x: number;
  y: number;
}

export interface ScrollBox {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

/** The fraction of the picture at the middle of the viewport. */
export function viewCentre(box: ScrollBox): ViewCentre {
  const ratio = (scroll: number, client: number, total: number) => (total > 0 ? Math.min(1, Math.max(0, (scroll + client / 2) / total)) : 0.5);
  return { x: ratio(box.scrollLeft, box.clientWidth, box.scrollWidth), y: ratio(box.scrollTop, box.clientHeight, box.scrollHeight) };
}

/**
 * The scroll offsets that put `centre` in the middle of the viewport, clamped to the scrollable range. Zooming keeps
 * the same spot in view instead of jumping to the picture's top-left corner (where a step's new parts rarely are).
 */
export function scrollForCentre(centre: ViewCentre, box: Pick<ScrollBox, "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight">): { left: number; top: number } {
  const offset = (fraction: number, client: number, total: number) => Math.min(Math.max(0, total - client), Math.max(0, fraction * total - client / 2));
  return { left: offset(centre.x, box.clientWidth, box.scrollWidth), top: offset(centre.y, box.clientHeight, box.scrollHeight) };
}
