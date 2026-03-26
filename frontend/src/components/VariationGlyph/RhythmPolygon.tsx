// RhythmPolygon — middle 8-sided polygon
// Each vertex encodes one rhythmic/dynamic feature, normalized 0–1 across all segments.
import type { ThemeTokens } from '../../theme'
import type { RhythmAxes } from '../../utils/normalize'
import { RHYTHM_AXIS_LABELS, RHYTHM_AXIS_DISPLAY } from '../../utils/normalize'

interface Props {
  axes: RhythmAxes       // normalized 0–1
  maxRadius: number      // px
  cx: number
  cy: number
  theme: ThemeTokens
}

const N = 8
const ANGLE_STEP = (2 * Math.PI) / N
const START_OFFSET = -Math.PI / 2  // 0° at top

function polarToXY(angle: number, r: number): [number, number] {
  return [r * Math.cos(angle), r * Math.sin(angle)]
}

function buildPath(radii: number[], maxR: number): string {
  const points = radii.map((r, i) => {
    const angle = START_OFFSET + i * ANGLE_STEP
    const [x, y] = polarToXY(angle, r * maxR)
    return `${x},${y}`
  })
  return `M ${points[0]} L ${points.slice(1).join(' L ')} Z`
}

// Faint grid rings at 25%, 50%, 75%, 100%
function GridRings({ maxR, color }: { maxR: number; color: string }) {
  return (
    <>
      {[0.25, 0.5, 0.75, 1.0].map(t => (
        <circle
          key={t}
          r={t * maxR}
          fill="none"
          stroke={color}
          strokeWidth={t === 1.0 ? 0.8 : 0.4}
          strokeDasharray={t < 1 ? '2 3' : ''}
          opacity={0.25}
        />
      ))}
      {/* Axis spokes */}
      {RHYTHM_AXIS_LABELS.map((_, i) => {
        const angle = START_OFFSET + i * ANGLE_STEP
        const [x, y] = polarToXY(angle, maxR)
        return (
          <line key={i} x1={0} y1={0} x2={x} y2={y}
            stroke={color} strokeWidth={0.4} opacity={0.2} />
        )
      })}
    </>
  )
}

export function RhythmPolygon({ axes, maxRadius, cx, cy, theme }: Props) {
  const radii = RHYTHM_AXIS_LABELS.map(k => axes[k])
  const polyPath = buildPath(radii, maxRadius)

  return (
    <g transform={`translate(${cx},${cy})`} aria-label="Rhythm polygon">
      <GridRings maxR={maxRadius} color={theme.rhythmStroke} />

      <path
        d={polyPath}
        fill={theme.rhythmFill}
        fillOpacity={theme.rhythmFillOpacity}
        stroke={theme.rhythmStroke}
        strokeWidth={theme.rhythmStrokeWidth}
        strokeLinejoin="round"
      />

      {/* Vertex dots */}
      {radii.map((r, i) => {
        const angle = START_OFFSET + i * ANGLE_STEP
        const [x, y] = polarToXY(angle, r * maxRadius)
        return (
          <circle key={i} cx={x} cy={y} r={2}
            fill={theme.rhythmStroke} opacity={0.6} />
        )
      })}

      {/* Axis labels — visible only in scientific theme */}
      {theme.showAxisLabels && RHYTHM_AXIS_LABELS.map((k, i) => {
        const angle = START_OFFSET + i * ANGLE_STEP
        const [x, y] = polarToXY(angle, maxRadius + 9)
        const anchor = Math.abs(x) < 2 ? 'middle' : x > 0 ? 'start' : 'end'
        return (
          <text key={i} x={x} y={y}
            textAnchor={anchor}
            dominantBaseline="central"
            fontSize={6.5}
            fill={theme.axisLabelColor}
            fontFamily={theme.fontFamily}
          >
            {RHYTHM_AXIS_DISPLAY[k]}
          </text>
        )
      })}
    </g>
  )
}
