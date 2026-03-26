// TimbreCore — inner MFCC hexagon + mode-indicator dot
import type { ThemeTokens } from '../../theme'
import { modeScore } from '../../utils/normalize'
import { modeColor } from '../../constants/colors'

interface Props {
  mfccNorm: number[]      // 6 values, each in [0.05, 1]
  chromaCof: number[]     // for mode score computation
  maxRadius: number       // px
  cx: number
  cy: number
  theme: ThemeTokens
}

const N = 6
const ANGLE_STEP = (2 * Math.PI) / N
const START_OFFSET = -Math.PI / 2

function polarXY(angle: number, r: number): [number, number] {
  return [r * Math.cos(angle), r * Math.sin(angle)]
}

export function TimbreCore({ mfccNorm, chromaCof, maxRadius, cx, cy, theme }: Props) {
  // Build hexagon path
  const points = mfccNorm.map((r, i) => {
    const angle = START_OFFSET + i * ANGLE_STEP
    const [x, y] = polarXY(angle, r * maxRadius)
    return `${x},${y}`
  })
  const hexPath = `M ${points[0]} L ${points.slice(1).join(' L ')} Z`

  // Mode indicator
  const score = modeScore(chromaCof)
  const dotColor = modeColor(score)
  const dotR = theme.modeDotRadius
  const modeLabel = score > 0.15 ? 'M' : score < -0.15 ? 'm' : '~'

  return (
    <g transform={`translate(${cx},${cy})`} aria-label="Timbre core">
      {/* Hexagon outline for reference */}
      {Array.from({ length: N }).map((_, i) => {
        const angle = START_OFFSET + i * ANGLE_STEP
        const [x, y] = polarXY(angle, maxRadius)
        const next = START_OFFSET + ((i + 1) % N) * ANGLE_STEP
        const [nx, ny] = polarXY(next, maxRadius)
        return (
          <line key={i} x1={x} y1={y} x2={nx} y2={ny}
            stroke={theme.timbreStroke} strokeWidth={0.4} opacity={0.15} />
        )
      })}

      {/* MFCC hexagon */}
      <path
        d={hexPath}
        fill={theme.timbreFill}
        fillOpacity={theme.timbreFillOpacity}
        stroke={theme.timbreStroke}
        strokeWidth={theme.timbreStrokeWidth}
        strokeLinejoin="round"
      />

      {/* Mode indicator dot */}
      <circle r={dotR} fill={dotColor} opacity={0.92}>
        <title>
          Mode score: {score.toFixed(2)} ({score > 0.15 ? 'Major tendency' : score < -0.15 ? 'Minor tendency' : 'Neutral'})
        </title>
      </circle>

      {/* Mode label — scientific theme only */}
      {theme.showAxisLabels && (
        <text
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={7}
          fontWeight={600}
          fill="white"
          fontFamily={theme.fontFamily}
          style={{ userSelect: 'none' }}
        >
          {modeLabel}
        </text>
      )}
    </g>
  )
}
