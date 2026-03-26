// ChromaRing — outer ring of the Glyph
// 12 arc sectors in circle-of-fifths order; sector radius ∝ chroma energy.
import { arc } from 'd3'
import type { ThemeTokens } from '../../theme'
import { chromaOuterRadius } from '../../utils/normalize'
import { cofHue } from '../../constants/colors'

interface Props {
  chromaCof: number[]      // 12 values (COF order), sum ≈ 1
  innerRadius: number      // px — shared boundary with RhythmPolygon
  maxArcHeight: number     // px — max extension beyond innerRadius
  cx: number
  cy: number
  theme: ThemeTokens
}

const TWO_PI = 2 * Math.PI
const ANGLE_STEP = TWO_PI / 12
const START_OFFSET = -Math.PI / 2  // start from 12 o'clock

const arcGen = arc<{ inner: number; outer: number; start: number; end: number }>()
  .innerRadius(d => d.inner)
  .outerRadius(d => d.outer)
  .startAngle(d => d.start)
  .endAngle(d => d.end)
  .padAngle(0.018)
  .padRadius(d => d.inner)
  .cornerRadius(1.5)

export function ChromaRing({ chromaCof, innerRadius, maxArcHeight, cx, cy, theme }: Props) {
  const sectors = chromaCof.map((value, i) => {
    const startAngle = START_OFFSET + i * ANGLE_STEP
    const endAngle   = startAngle + ANGLE_STEP
    const outerRadius = chromaOuterRadius(value, innerRadius, maxArcHeight)
    const d = arcGen({ inner: innerRadius, outer: outerRadius, start: startAngle, end: endAngle })
    const hue = cofHue(i)
    const color = theme.chromaColors[i]
    return { d, color, hue, value, name: ['C','G','D','A','E','B','F#','Db','Ab','Eb','Bb','F'][i] }
  })

  return (
    <g transform={`translate(${cx},${cy})`} aria-label="Chroma ring">
      {sectors.map((s, i) => (
        <path
          key={i}
          d={s.d ?? ''}
          fill={s.color}
          fillOpacity={theme.chromaFillOpacity}
          stroke={theme.chromaStroke}
          strokeWidth={theme.chromaStrokeWidth}
        >
          <title>{s.name}: {(s.value * 100).toFixed(1)}%</title>
        </path>
      ))}
    </g>
  )
}
