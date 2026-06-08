// VariVis — Feature normalization utilities

/** Clamp x into [lo, hi] */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// ── Chroma arc outer radius ───────────────────────────────────────
// Fixed scale: a chroma value of 0.25 fills the full arc height.
// Consistent across all segments so glyphs are directly comparable.

export function chromaOuterRadius(
  value: number,
  innerRadius: number,
  maxArcHeight: number,
  referenceMax = 0.25,
): number {
  const height = clamp((value / referenceMax) * maxArcHeight, 1, maxArcHeight)
  return innerRadius + height
}
