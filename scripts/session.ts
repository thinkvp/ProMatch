/**
 * Read a panel session's point sizes the way the panel does (src/panel/app.ts
 * radiusOf): per-point radius, else the legacy session radius, else the
 * frame's default (width / 190), times the Sample size slider.
 */
export interface SessionPt {
  x: number
  y: number
  r?: number
}

export function pointRadius(session: { radius?: number; radiusScale?: number }, frameWidth: number, pt: SessionPt): number {
  const base = pt.r ?? session.radius ?? Math.max(4, Math.round(frameWidth / 190))
  return Math.max(1.5, base * Math.max(0.05, 1 + (session.radiusScale ?? 0) / 100))
}
