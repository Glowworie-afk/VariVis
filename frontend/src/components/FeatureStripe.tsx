// FeatureStripe — fixed-width compressed time representation (Method B)
// 3 rows: RMS energy · Spectral centroid · Chroma heatmap (12 × 64)
// Uses <canvas> for efficient pixel rendering.
import { useEffect, useRef } from 'react'
import type { CompressedFeatures } from '../types/features'
import type { ThemeTokens } from '../theme'
import { CHROMA_COLORS_SCIENTIFIC, CHROMA_COLORS_ARTISTIC } from '../constants/colors'

interface Props {
  compressed: CompressedFeatures
  width: number     // CSS px (matches glyph width)
  theme: ThemeTokens
}

// Parse 'hsl(h,s%,l%)' to [r,g,b]
function hslToRgb(hsl: string): [number, number, number] {
  const m = hsl.match(/hsl\((\d+),(\d+)%,(\d+)%\)/)
  if (!m) return [128, 128, 128]
  const h = parseInt(m[1]) / 360
  const s = parseInt(m[2]) / 100
  const l = parseInt(m[3]) / 100
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1/6) return p + (q - p) * 6 * t
    if (t < 1/2) return q
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6
    return p
  }
  return [
    Math.round(hue2rgb(h + 1/3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1/3) * 255),
  ]
}

const ROW_H = 14   // px per row
const GAP   = 1
const TOTAL_H = ROW_H * 3 + GAP * 2

export function FeatureStripe({ compressed, width, theme }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDark = theme.pageBg.startsWith('#0')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const N = compressed.n_frames
    const cellW = canvas.width / N

    const bg = isDark ? 15 : 248
    ctx.fillStyle = `rgb(${bg},${bg},${bg})`
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // ── Row 0: RMS energy (dark → bright) ──
    const rms = compressed.rms
    const rmsMax = Math.max(...rms, 1e-6)
    for (let i = 0; i < N; i++) {
      const t = rms[i] / rmsMax
      const _v = isDark ? Math.round(t * 220) : Math.round(255 - t * 220); void _v
      const r = isDark ? Math.round(t * 255) : Math.round(255 - t * 180)
      const g = isDark ? Math.round(t * 160) : Math.round(255 - t * 200)
      const b = isDark ? Math.round(20)       : Math.round(255 - t * 200)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(Math.round(i * cellW), 0, Math.ceil(cellW), ROW_H)
    }

    // ── Row 1: Spectral centroid (blue → yellow) ──
    const cent = compressed.spectral_centroid
    const centMin = Math.min(...cent)
    const centMax = Math.max(...cent, centMin + 1)
    const row1Y = ROW_H + GAP
    for (let i = 0; i < N; i++) {
      const t = (cent[i] - centMin) / (centMax - centMin)
      // Interpolate: deep-blue → cyan → yellow
      const r = Math.round(t < 0.5 ? t * 2 * 100 : 100 + (t - 0.5) * 2 * 155)
      const g = Math.round(t < 0.5 ? t * 2 * 200 : 255)
      const b = Math.round(t < 0.5 ? 200 - t * 2 * 200 : 0)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(Math.round(i * cellW), row1Y, Math.ceil(cellW), ROW_H)
    }

    // ── Row 2: Chroma heatmap (12 pitch classes stacked into 1 row) ──
    // Each frame: colour = blend of COF colours weighted by chroma values
    const chroma = compressed.chroma_cof  // [12][N]
    const colorMap = isDark ? CHROMA_COLORS_ARTISTIC : CHROMA_COLORS_SCIENTIFIC
    const rgbs = colorMap.map(hslToRgb)
    const row2Y = (ROW_H + GAP) * 2

    for (let i = 0; i < N; i++) {
      const frame = chroma.map(row => row[i])
      const sum = frame.reduce((a, b) => a + b, 0) || 1
      let R = 0, G = 0, B = 0
      frame.forEach((v, p) => {
        const w = v / sum
        R += w * rgbs[p][0]
        G += w * rgbs[p][1]
        B += w * rgbs[p][2]
      })
      ctx.fillStyle = `rgb(${Math.round(R)},${Math.round(G)},${Math.round(B)})`
      ctx.fillRect(Math.round(i * cellW), row2Y, Math.ceil(cellW), ROW_H)
    }
  }, [compressed, isDark])

  return (
    <canvas
      ref={canvasRef}
      width={width * 2}           // hi-DPI: 2× physical pixels
      height={TOTAL_H * 2}
      style={{ width, height: TOTAL_H, display: 'block' }}
      aria-label="Feature stripe"
    />
  )
}
