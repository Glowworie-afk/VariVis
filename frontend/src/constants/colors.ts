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

// Distinct colours per segment index (used for pitch contour labels)
const LABEL_COLORS = [
  '#4CC9F0', '#F72585', '#7209B7', '#3A0CA3',
  '#4361EE', '#06D6A0', '#F77F00', '#2EC4B6',
  '#E9C46A', '#E76F51', '#264653', '#A8DADC',
  '#457B9D', '#1D3557',
]

/**
 * Segment index → distinct label color for pitch contour rendering
 */
export function labelColor(index: number): string {
  return LABEL_COLORS[index % LABEL_COLORS.length]
}
