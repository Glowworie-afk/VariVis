/**
 * TensionOrnamentPage.tsx
 * ────────────────────────
 * Dual-panel view: Harmonic Tension Curve (top) × Ornament Density
 * Heatmap (bottom), sharing the same synchronized x-axis (bars).
 *
 * Tension (0–1): mean pairwise interval dissonance per bar.
 *   Higher → more chromatic / dissonant chords.
 * Ornament density: count of short-duration notes (< 0.25 beat)
 *   per bar, normalised to [0, 1] for colour mapping.
 *
 * The crosshair hover syncs both panels — hover anywhere to see
 * tension value + ornament count at the same bar.
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import { API_BASE } from '../api/pieceApi'

// ── Types ──────────────────────────────────────────────────────────────

interface BarData {
  bar:            number
  tension:        number
  ornament_count: number
  ornament_norm:  number
  section:        string
}

interface SectionSummary {
  label:           string
  bar_start:       number
  bar_end:         number
  mean_tension:    number
  max_tension:     number
  total_ornaments: number
}

interface ApiResponse {
  matched:    boolean
  file_name:  string
  midi_name?: string
  bars?:      BarData[]
  sections?:  SectionSummary[]
  var_labels?: string[]
  message?:   string
  ornament_thresh_beats?: number
}

// ── Palette ────────────────────────────────────────────────────────────

const SECTION_COLORS = [
  '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#a78bfa', '#fb923c', '#34d399',
]

/** Interpolate tension 0→1 through a cool–warm gradient */
function tensionColor(t: number): string {
  // 0 = steel blue, 0.5 = gold, 1 = crimson
  const stops = [
    [67, 130, 200],   // 0.0 — blue (consonant)
    [250, 190, 60],   // 0.5 — amber
    [220, 38,  38],   // 1.0 — red (dissonant)
  ]
  const scaled = Math.max(0, Math.min(1, t)) * 2   // 0–2
  const lo = Math.floor(scaled)
  const hi = Math.min(lo + 1, 2)
  const frac = scaled - lo
  const [r1, g1, b1] = stops[lo]
  const [r2, g2, b2] = stops[hi]
  const r = Math.round(r1 + (r2 - r1) * frac)
  const g = Math.round(g1 + (g2 - g1) * frac)
  const b = Math.round(b1 + (b2 - b1) * frac)
  return `rgb(${r},${g},${b})`
}

/** Ornament heat: 0 = transparent, 1 = deep violet */
function ornamentColor(norm: number): string {
  if (norm <= 0) return 'transparent'
  const alpha = 0.12 + norm * 0.78   // 0.12–0.90
  const r = Math.round(139 + (80 - 139) * norm)
  const g = Math.round(92  + (10 - 92)  * norm)
  const b = Math.round(246 + (220 - 246) * norm)
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`
}

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  fileName:    string
  theme:       ThemeTokens
  lang:        Lang
  nVariations?: number | null
}

// ── Component ──────────────────────────────────────────────────────────

export default function TensionOrnamentPage({ fileName, theme, lang, nVariations }: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [data,   setData]   = useState<ApiResponse | null>(null)
  const [errMsg, setErrMsg] = useState('')
  const [hoverBar, setHoverBar] = useState<number | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)

  // ── Fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    setStatus('loading'); setData(null); setErrMsg('')
    const params = nVariations != null ? `?n_variations=${nVariations}` : ''
    fetch(`${API_BASE}/midi/tension_ornament/${encodeURIComponent(fileName)}${params}`)
      .then(async r => {
        const body = await r.json()
        if (!r.ok) throw new Error(body?.detail ?? `HTTP ${r.status}`)
        return body as ApiResponse
      })
      .then(d => {
        if (!d.matched) { setStatus('error'); setErrMsg(d.message ?? 'No data') }
        else { setData(d); setStatus('ready') }
      })
      .catch(e => { setStatus('error'); setErrMsg(String(e)) })
  }, [fileName, nVariations])

  // ── Mouse tracking (shared across both panels) ────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!data?.bars || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const relX = e.clientX - rect.left - PAD_L
    const frac = Math.max(0, Math.min(1, relX / (rect.width - PAD_L - PAD_R)))
    const barIdx = Math.round(frac * (data.bars.length - 1))
    setHoverBar(barIdx)
  }, [data])

  const handleMouseLeave = useCallback(() => setHoverBar(null), [])

  // ── Loading / error states ────────────────────────────────────────
  if (status === 'loading') return (
    <div style={{ padding: '40px 20px', textAlign: 'center', fontSize: 11,
                  color: theme.labelSecondaryColor, fontFamily: theme.fontFamily }}>
      <div>⏳ {t('正在计算和声张力与装饰音密度…', 'Computing harmonic tension & ornament density…')}</div>
      <div style={{ fontSize: 9, marginTop: 8, opacity: 0.6 }}>
        {t('MIDI 解析中…', 'Parsing MIDI…')}
      </div>
    </div>
  )

  if (status === 'error') return (
    <div style={{ padding: '20px', fontSize: 11, color: '#ef4444',
                  fontFamily: theme.fontFamily, lineHeight: 1.7 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        {t('加载失败', 'Could not load data')}
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 10, opacity: 0.85 }}>{errMsg}</div>
    </div>
  )

  if (status !== 'ready' || !data?.bars) return null

  const bars     = data.bars
  const sections = data.sections ?? []
  const labels   = data.var_labels ?? []

  const colorMap: Record<string, string> = {}
  labels.forEach((lbl, i) => { colorMap[lbl] = SECTION_COLORS[i % SECTION_COLORS.length] })

  const hoveredBar = hoverBar !== null ? bars[Math.min(hoverBar, bars.length - 1)] : null

  // ── Chart constants ───────────────────────────────────────────────
  const HEAT_ROW_H = 20   // px per variation row in heatmap

  return (
    <div style={{ padding: '10px 14px', fontFamily: theme.fontFamily }}>

      {/* ── Title bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap',
                    gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: theme.labelColor }}>
          {t(' 和声张力 × 装饰音密度', ' Harmonic Tension × Ornament Density')}
        </span>
        <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
          {t('红色 = 不协和峰值 · 紫色格 = 装饰音密集', 'Red = dissonance peak · Purple = ornament-dense bar')}
        </span>
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
        {/* Tension gradient swatch */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 60, height: 10, borderRadius: 3,
            background: 'linear-gradient(to right, rgb(67,130,200), rgb(250,190,60), rgb(220,38,38))',
          }} />
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
            {t('张力（协和→不协和）', 'Tension (consonant → dissonant)')}
          </span>
        </div>
        {/* Ornament swatch */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'flex', gap: 2 }}>
            {[0.1, 0.4, 0.7, 1.0].map(v => (
              <div key={v} style={{
                width: 10, height: 10, borderRadius: 2,
                background: ornamentColor(v),
                border: '1px solid #5555',
              }} />
            ))}
          </div>
          <span style={{ fontSize: 9, color: theme.labelSecondaryColor }}>
            {t('装饰音密度', 'Ornament density')}
          </span>
        </div>
      </div>

      {/* ── Main chart area (ref for mouse tracking) ── */}
      <div
        ref={containerRef}
        style={{ position: 'relative', userSelect: 'none' }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <TensionChart
          bars={bars}
          sections={sections}
          colorMap={colorMap}
          hoverBar={hoverBar}
          theme={theme}
          t={t}
        />

        <div style={{ marginTop: 4 }}>
          <OrnamentHeatmap
            bars={bars}
            sections={sections}
            labels={labels}
            colorMap={colorMap}
            hoverBar={hoverBar}
            rowH={HEAT_ROW_H}
            theme={theme}
            t={t}
          />
        </div>

        {/* Shared crosshair line (absolute overlay) */}
        {hoverBar !== null && hoveredBar && containerRef.current && (
          <CrosshairOverlay
            hoverBar={hoverBar}
            totalBars={bars.length}
            hoveredBar={hoveredBar}
            theme={theme}
            t={t}
          />
        )}
      </div>

      {/* ── Per-section summary cards ── */}
      <SectionCards sections={sections} colorMap={colorMap} theme={theme} t={t} />

      {/* ── Footer note ── */}
      <div style={{ marginTop: 10, fontSize: 9, color: theme.labelSecondaryColor, lineHeight: 1.6 }}>
        {t(
          '张力 = 每小节各 0.25 拍槽内音程不协和度均值（0=纯协和，1=最大不协和）。装饰音 = 时值 < 0.25 拍的音符数。',
          'Tension = mean interval dissonance per 0.25-beat slot per bar (0=consonant, 1=maximally dissonant). Ornaments = notes with duration < 0.25 beat.',
        )}
      </div>

    </div>
  )
}

// ── Layout constants (shared between sub-components) ─────────────────
const PAD_L = 48
const PAD_R = 16
const PAD_T = 20
const PAD_B = 28
const CHART_H = 160   // tension chart inner height (px, not SVG units)

// ── TensionChart sub-component ────────────────────────────────────────

function TensionChart({ bars, sections, colorMap, hoverBar, theme, t }: {
  bars: BarData[]
  sections: SectionSummary[]
  colorMap: Record<string, string>
  hoverBar: number | null
  theme: ThemeTokens
  t: (zh: string, en: string) => string
}) {
  const W = 820
  const H = PAD_T + CHART_H + PAD_B
  const innerW = W - PAD_L - PAD_R
  const n = bars.length

  const xOf = (i: number) => PAD_L + (i / Math.max(n - 1, 1)) * innerW
  const yOf = (v: number) => PAD_T + (1 - v) * CHART_H

  // Smooth polyline using bars tension
  const pts = bars.map((b, i) => `${xOf(i).toFixed(1)},${yOf(b.tension).toFixed(1)}`).join(' ')

  // Filled area under curve
  const areaPath = [
    `M${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}`,
    ...bars.map((b, i) => `L${xOf(i).toFixed(1)},${yOf(b.tension).toFixed(1)}`),
    `L${xOf(n - 1).toFixed(1)},${yOf(0).toFixed(1)}`,
    'Z',
  ].join(' ')

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0]

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: theme.labelColor, marginBottom: 4 }}>
        {t('和声张力曲线', 'Harmonic Tension Curve')}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: W, display: 'block', overflow: 'visible' }}
      >
        {/* Section bands */}
        {sections.map(sec => {
          const x1 = xOf(sec.bar_start)
          const x2 = xOf(Math.min(sec.bar_end, n - 1))
          return (
            <rect key={sec.label} x={x1} y={PAD_T} width={x2 - x1} height={CHART_H}
                  fill={colorMap[sec.label] ?? '#999'} fillOpacity={0.07} />
          )
        })}

        {/* Y grid */}
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD_L} y1={yOf(v)} x2={PAD_L + innerW} y2={yOf(v)}
                  stroke={v === 0 ? '#55555555' : '#55555533'}
                  strokeWidth={v === 0.5 ? 1 : 0.5}
                  strokeDasharray={v === 0 ? 'none' : '3,3'} />
            <text x={PAD_L - 5} y={yOf(v) + 3.5}
                  textAnchor="end" fontSize={8}
                  fill={theme.labelSecondaryColor ?? '#888'}>
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {/* Section boundary lines + labels */}
        {sections.map((sec, i) => {
          if (i === 0) return null
          const x = xOf(sec.bar_start)
          const color = colorMap[sec.label] ?? '#999'
          return (
            <g key={sec.label}>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + CHART_H}
                    stroke={color} strokeWidth={1} strokeDasharray="4,3" opacity={0.5} />
              <text x={x + 3} y={PAD_T + 10} fontSize={8} fill={color} fontWeight={700}>
                {sec.label}
              </text>
            </g>
          )
        })}

        {/* Gradient filled area */}
        <defs>
          <linearGradient id="tensionGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="#dc2626" stopOpacity={0.35} />
            <stop offset="50%"  stopColor="#f59e0b" stopOpacity={0.20} />
            <stop offset="100%" stopColor="#4382c8" stopOpacity={0.08} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#tensionGrad)" />

        {/* Tension line — coloured by local tension value */}
        {bars.slice(0, -1).map((b, i) => (
          <line key={i}
            x1={xOf(i).toFixed(1)} y1={yOf(b.tension).toFixed(1)}
            x2={xOf(i + 1).toFixed(1)} y2={yOf(bars[i + 1].tension).toFixed(1)}
            stroke={tensionColor((b.tension + bars[i + 1].tension) / 2)}
            strokeWidth={1.8}
            strokeLinejoin="round"
          />
        ))}

        {/* Hover marker */}
        {hoverBar !== null && hoverBar < bars.length && (
          <circle
            cx={xOf(hoverBar)} cy={yOf(bars[hoverBar].tension)}
            r={4} fill={tensionColor(bars[hoverBar].tension)}
            stroke="#fff" strokeWidth={1.5}
          />
        )}

        {/* X axis label */}
        <text x={PAD_L + innerW / 2} y={H - 6}
              textAnchor="middle" fontSize={8}
              fill={theme.labelSecondaryColor ?? '#888'}>
          {t('→ 小节', '→ Bar')}
        </text>

        {/* Y axis label */}
        <text x={13} y={PAD_T + CHART_H / 2}
              textAnchor="middle" fontSize={8}
              fill={theme.labelSecondaryColor ?? '#888'}
              transform={`rotate(-90,13,${PAD_T + CHART_H / 2})`}>
          {t('张力', 'Tension')}
        </text>
      </svg>
    </div>
  )
}

// ── OrnamentHeatmap sub-component ─────────────────────────────────────

function OrnamentHeatmap({ bars, sections, labels, colorMap, hoverBar, rowH, theme, t }: {
  bars: BarData[]
  sections: SectionSummary[]
  labels: string[]
  colorMap: Record<string, string>
  hoverBar: number | null
  rowH: number
  theme: ThemeTokens
  t: (zh: string, en: string) => string
}) {
  const W      = 820
  const innerW = W - PAD_L - PAD_R
  const n      = bars.length
  const barW   = innerW / n
  const H      = rowH * labels.length + 28   // rows + bottom axis

  const xOf = (i: number) => PAD_L + (i / n) * innerW

  // For each variation section row, draw coloured cells
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: theme.labelColor, marginBottom: 4 }}>
        {t('装饰音密度热图', 'Ornament Density Heatmap')}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`}
           style={{ width: '100%', maxWidth: W, display: 'block' }}>

        {/* Row labels + cells */}
        {labels.map((lbl, rowIdx) => {
          const sec = sections.find(s => s.label === lbl)
          if (!sec) return null
          const y = rowIdx * rowH
          const color = colorMap[lbl] ?? '#999'

          // Bars in this section
          const secBars = bars.filter(b => b.bar >= sec.bar_start && b.bar < sec.bar_end)

          return (
            <g key={lbl}>
              {/* Row label */}
              <text x={PAD_L - 5} y={y + rowH * 0.68}
                    textAnchor="end" fontSize={8}
                    fill={color} fontWeight={700}>
                {lbl}
              </text>
              {/* Cells */}
              {secBars.map(b => (
                <rect key={b.bar}
                  x={xOf(b.bar)} y={y + 1}
                  width={Math.max(1, barW - 0.5)} height={rowH - 2}
                  fill={ornamentColor(b.ornament_norm)}
                  rx={1}
                />
              ))}
              {/* Row border */}
              <line x1={PAD_L} y1={y} x2={PAD_L + innerW} y2={y}
                    stroke="#55555520" strokeWidth={0.5} />
            </g>
          )
        })}

        {/* Bottom border */}
        <line x1={PAD_L} y1={labels.length * rowH} x2={PAD_L + innerW} y2={labels.length * rowH}
              stroke="#55555540" strokeWidth={0.8} />

        {/* Section boundary marks on x-axis */}
        {sections.map((sec, i) => {
          if (i === 0) return null
          const x = xOf(sec.bar_start)
          return (
            <line key={sec.label}
                  x1={x} y1={0} x2={x} y2={labels.length * rowH}
                  stroke={colorMap[sec.label] ?? '#999'}
                  strokeWidth={0.8} strokeDasharray="3,3" opacity={0.4} />
          )
        })}

        {/* Hover column highlight */}
        {hoverBar !== null && (
          <rect x={xOf(hoverBar)} y={0}
                width={Math.max(1, barW)}
                height={labels.length * rowH}
                fill="#ffffff" fillOpacity={0.12}
                stroke="#fff" strokeWidth={0.5} strokeOpacity={0.3} />
        )}

        {/* X-axis tick marks (one per section boundary) */}
        {sections.map(sec => (
          <text key={sec.label}
                x={xOf(sec.bar_start) + 2}
                y={labels.length * rowH + 14}
                fontSize={8} fill={theme.labelSecondaryColor ?? '#888'}>
            {t(`m.${sec.bar_start + 1}`, `m.${sec.bar_start + 1}`)}
          </text>
        ))}

      </svg>
    </div>
  )
}

// ── Crosshair tooltip overlay ─────────────────────────────────────────

function CrosshairOverlay({ hoverBar, totalBars, hoveredBar, theme, t }: {
  hoverBar: number
  totalBars: number
  hoveredBar: BarData
  theme: ThemeTokens
  t: (zh: string, en: string) => string
}) {
  // Position as % — works regardless of container width
  const pct = (hoverBar / Math.max(totalBars - 1, 1)) * 100

  return (
    <>
      {/* Vertical crosshair line spanning both panels */}
      <div style={{
        position:  'absolute',
        top:       0,
        bottom:    0,
        left:      `calc(${PAD_L}px + ${pct}% * (1 - ${(PAD_L + PAD_R) / 820}))`,
        width:     1,
        background: '#ffffff55',
        pointerEvents: 'none',
        transform: 'translateX(-50%)',
      }} />

      {/* Tooltip */}
      <div style={{
        position:  'absolute',
        top:       4,
        left:      pct > 70 ? undefined : `calc(${PAD_L}px + ${pct}% + 10px)`,
        right:     pct > 70 ? `calc(${PAD_R}px + ${100 - pct}% + 10px)` : undefined,
        background: '#1e1e2e',
        color:     '#e2e8f0',
        borderRadius: 6,
        padding:   '6px 10px',
        fontSize:  10,
        pointerEvents: 'none',
        boxShadow: '0 2px 10px #0006',
        border:    `1px solid ${tensionColor(hoveredBar.tension)}55`,
        lineHeight: 1.7,
        minWidth:  160,
        zIndex:    10,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 3,
                      color: tensionColor(hoveredBar.tension) }}>
          {hoveredBar.section} — {t('第', 'Bar')} {hoveredBar.bar + 1}
        </div>
        <div>
          {t('张力', 'Tension')}:{' '}
          <span style={{ fontWeight: 700, color: tensionColor(hoveredBar.tension) }}>
            {hoveredBar.tension.toFixed(3)}
          </span>
        </div>
        <div>
          {t('装饰音', 'Ornaments')}:{' '}
          <span style={{ fontWeight: 700, color: '#a78bfa' }}>
            {hoveredBar.ornament_count}
          </span>
          {hoveredBar.ornament_count > 0 && (
            <span style={{ fontSize: 9, opacity: 0.7, marginLeft: 4 }}>
              ({t('此小节', 'in this bar')})
            </span>
          )}
        </div>
      </div>
    </>
  )
}

// ── SectionCards sub-component ────────────────────────────────────────

function SectionCards({ sections, colorMap, theme, t }: {
  sections: SectionSummary[]
  colorMap: Record<string, string>
  theme: ThemeTokens
  t: (zh: string, en: string) => string
}) {
  if (!sections.length) return null
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: theme.labelColor, marginBottom: 6 }}>
        {t('各段摘要', 'Section summary')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sections.map(sec => {
          const color = colorMap[sec.label] ?? '#999'
          return (
            <div key={sec.label} style={{
              flex: '0 0 auto', padding: '6px 10px', borderRadius: 8,
              border: `1px solid ${color}44`, background: `${color}0d`, minWidth: 110,
            }}>
              <div style={{ fontWeight: 700, fontSize: 10, color, marginBottom: 3 }}>
                {sec.label}
              </div>
              <div style={{ fontSize: 9, color: theme.labelSecondaryColor, lineHeight: 1.7 }}>
                <div>
                  {t('均值张力', 'Mean tension')}:{' '}
                  <span style={{ color: tensionColor(sec.mean_tension), fontWeight: 600 }}>
                    {sec.mean_tension.toFixed(3)}
                  </span>
                </div>
                <div>
                  {t('峰值张力', 'Peak tension')}:{' '}
                  <span style={{ color: tensionColor(sec.max_tension), fontWeight: 600 }}>
                    {sec.max_tension.toFixed(3)}
                  </span>
                </div>
                <div>
                  {t('装饰音总数', 'Total ornaments')}:{' '}
                  <span style={{ color: '#a78bfa', fontWeight: 600 }}>
                    {sec.total_ornaments}
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
