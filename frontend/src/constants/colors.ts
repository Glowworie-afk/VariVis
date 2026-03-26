// VariVis — Circle-of-fifths color palette
// COF order: C G D A E B F# Db Ab Eb Bb F
// Hue steps 30° apart so harmonically related keys share similar hues

export const COF_NAMES = ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'] as const

// Scientific theme: sat 70%, lightness 48%
export const CHROMA_COLORS_SCIENTIFIC: string[] = [
  'hsl(0,70%,48%)',    // C   red
  'hsl(30,70%,48%)',   // G   orange
  'hsl(60,70%,48%)',   // D   amber
  'hsl(90,70%,48%)',   // A   yellow-green
  'hsl(120,70%,42%)',  // E   green (slightly darker)
  'hsl(150,70%,42%)',  // B   teal-green
  'hsl(180,70%,45%)',  // F#  cyan
  'hsl(210,70%,52%)',  // Db  sky-blue
  'hsl(240,70%,58%)',  // Ab  blue
  'hsl(270,65%,55%)',  // Eb  violet
  'hsl(300,65%,52%)',  // Bb  magenta
  'hsl(330,70%,52%)',  // F   rose
]

// Artistic theme: sat 90%, lightness 60% — more vivid
export const CHROMA_COLORS_ARTISTIC: string[] = [
  'hsl(0,90%,60%)',
  'hsl(30,90%,60%)',
  'hsl(60,90%,58%)',
  'hsl(90,90%,55%)',
  'hsl(120,85%,52%)',
  'hsl(150,85%,52%)',
  'hsl(180,88%,55%)',
  'hsl(210,88%,65%)',
  'hsl(240,85%,68%)',
  'hsl(270,82%,65%)',
  'hsl(300,82%,65%)',
  'hsl(330,88%,63%)',
]

/**
 * Mode indicator dot color.
 * mode_score ∈ [-1, +1]: +1 = major, -1 = minor
 * Interpolates: major (#E76F51 warm) → neutral (#8D99AE) → minor (#4895EF cool)
 */
export function modeColor(modeScore: number): string {
  const t = (modeScore + 1) / 2   // map [-1,1] → [0,1]
  if (t >= 0.5) {
    // neutral → major: 0.5→1  maps to gray→orange
    const s = (t - 0.5) * 2
    const r = Math.round(141 + s * (231 - 141))
    const g = Math.round(153 + s * (111 - 153))
    const b = Math.round(174 + s * (81  - 174))
    return `rgb(${r},${g},${b})`
  } else {
    // minor → neutral: 0→0.5  maps to blue→gray
    const s = t * 2
    const r = Math.round(72  + s * (141 - 72))
    const g = Math.round(149 + s * (153 - 149))
    const b = Math.round(239 + s * (174 - 239))
    return `rgb(${r},${g},${b})`
  }
}

/**
 * COF position index → hue in degrees (for background tint)
 */
export function cofHue(cofIndex: number): number {
  return cofIndex * 30
}
