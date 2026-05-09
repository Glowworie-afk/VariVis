// MdaAnalysisPage.tsx
// Almada (2023) MDA Penalty Analysis — Ch.1-3
// Computes kp / kt / kh / k entirely from pre-extracted audio features.
// No MIDI file required.
//
// Data sources (all from features JSON):
//   kp → pitch_contour.beat_midi (pYIN beat-aligned absolute MIDI)
//        fallback: chroma_chromatic cosine distance
//   kt → compressed.onset_count[64] (per-frame rhythm profile)
//        + onset_density, rhythm_regularity, tempo scalars
//   kh → chroma_chromatic, dominant_pitch, pitch_contour.tonic_semitone/is_major

import { useMemo, useState } from 'react'
import type { PieceData, Segment } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

type KpSrc = 'pyin' | 'chroma' | 'midi'
type KtSrc = 'onset_count' | 'scalars' | 'midi'

interface MdaSegment {
  label:   string
  kp:      number
  kt:      number
  kh:      number
  k:       number
  alpha:   number
  band:    string
  type:    string
  kp_src:  KpSrc
  kt_src:  KtSrc
}

// ── Style constants ───────────────────────────────────────────────────────────

const TYPE_META: Record<string, {
  label: string; labelZh: string; color: string; desc: string; descZh: string
}> = {
  melodic:   { label:'Melodic',        labelZh:'旋律变奏',      color:'#3b82f6',
               desc:'Pitch domain dominant',       descZh:'音高域变化为主 (kp >> kt, kh)' },
  rhythmic:  { label:'Rhythmic',       labelZh:'节奏变奏',      color:'#f59e0b',
               desc:'Temporal domain dominant',    descZh:'时值域变化为主 (kt >> kp, kh)' },
  harmonic:  { label:'Harmonic/Tonal', labelZh:'和声·调性变奏',  color:'#ef4444',
               desc:'Harmonic domain dominant',    descZh:'和声域变化为主 (kh >> kp, kt)' },
  hybrid:    { label:'Hybrid',         labelZh:'混合变奏',      color:'#8b5cf6',
               desc:'Multiple domains combined',   descZh:'多域复合变化' },
  reference: { label:'Theme',          labelZh:'主题',          color:'#10b981',
               desc:'Grundgestalt — referential',  descZh:'基础乐思 (Grundgestalt)' },
}

const BAND_COLORS = ['#3b82f6','#6366f1','#f59e0b','#ef4444'] // high→low

/** Penalty-to-heatmap colour: low k = green, mid = amber, high = red */
function kColor(k: number): string {
  if (k <= 0)   return TYPE_META.reference.color
  if (k < 0.30) return '#10b981'
  if (k < 0.50) return '#f59e0b'
  if (k < 0.70) return '#f97316'
  return '#ef4444'
}

// ── MDA computation ───────────────────────────────────────────────────────────

/** Normalised dot product of two 12-dim chroma vectors */
function chromaCos(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0)
  const ma = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  const mb = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
  return ma > 0 && mb > 0 ? dot / (ma * mb) : 0
}

/** Pitch ranks (melodic contour): 0 = lowest pitch in sequence */
function contourRanks(seq: number[]): number[] {
  const sorted = [...new Set(seq)].sort((a, b) => a - b)
  const rm = new Map(sorted.map((v, i) => [v, i]))
  return seq.map(x => rm.get(x) ?? 0)
}

/**
 * kp — Pitch penalty (Almada §3.2)
 * Source priority:
 *   1. score_beat_midi  (MIDI score — performance-independent, preferred)
 *   2. beat_midi        (pYIN beat-aligned — audio-derived)
 *   3. chroma cosine    (fallback when no pitch sequence available)
 */
function computeKp(theme: Segment, seg: Segment): { kp: number; src: 'pyin' | 'chroma' | 'midi' } {
  const pc_t = theme.features.pitch_contour
  const pc_s = seg.features.pitch_contour

  // ── MIDI score path (performance-independent) ──
  const useScoreMidi =
    pc_t?.score_beat_midi && pc_t.score_beat_midi.length > 2 &&
    pc_s?.score_beat_midi && pc_s.score_beat_midi.length > 2

  // ── pYIN path (audio-derived, fallback when no score MIDI) ──
  const usePyin = !useScoreMidi &&
    pc_t?.beat_midi && pc_t.beat_midi.length > 2 &&
    pc_s?.beat_midi && pc_s.beat_midi.length > 2 &&
    !pc_t.error && !pc_s.error

  if (useScoreMidi || usePyin) {
    const seq_t = useScoreMidi ? pc_t!.score_beat_midi! : pc_t!.beat_midi!
    const seq_s = useScoreMidi ? pc_s!.score_beat_midi! : pc_s!.beat_midi!
    const n = Math.min(seq_t.length, seq_s.length)
    const p1 = seq_t.slice(0, n)
    const c1 = seq_s.slice(0, n)
    const p2 = p1.map(x => ((x % 12) + 12) % 12)
    const c2 = c1.map(x => ((x % 12) + 12) % 12)
    const ivs = (s: number[]) => s.slice(1).map((v, i) => v - s[i])
    const pi = ivs(p1), ci = ivs(c1)
    const p4 = contourRanks(p1), c4 = contourRanks(c1)

    let v1 = p1.map((_, i) => Math.abs(c1[i] - p1[i]))
    let v2 = p2.map((_, i) => Math.min(Math.abs(c2[i]-p2[i]), 12-Math.abs(c2[i]-p2[i])))
    let v3 = pi.map((_, i) => Math.abs((ci[i] ?? 0) - pi[i]))
    let v4 = p4.map((_, i) => Math.abs(c4[i] - p4[i]))
    const p5 = Math.max(...p1) - Math.min(...p1)
    const c5 = Math.max(...c1) - Math.min(...c1)
    const v5 = Math.abs(c5 - p5)

    // Rule 1: octave transposition in intervals → 12 → 4
    v3 = v3.map(x => x === 12 ? 4 : x)
    // Rule 2: uniform transposition → replace v1,v2 with 2s
    if (new Set(v1).size === 1 && v1[0] > 0) { v1 = Array(n).fill(2); v2 = Array(n).fill(2) }
    // Rule 3: inversion → v3 ≈ 2×original intervals → 3
    if (v3.length > 0 && pi.filter((p, i) => Math.abs(v3[i] - 2*Math.abs(p)) < 2).length > v3.length*0.6)
      v3 = Array(v3.length).fill(3)
    // Rule 4: contour inversion → constant row sum → v4 = 1s
    if (n > 1 && new Set(p4.map((_, i) => p4[i] + c4[i])).size === 1)
      v4 = Array(n).fill(1)

    const WP = [15, 15, 40, 25, 5]
    const vp = [v1, v2, v3, v4].map(v => v.reduce((a, b) => a+b, 0)).concat(v5)
    const kp_raw = vp.reduce((s, v, i) => s + v * WP[i], 0)
    const kp_max = n*12*15 + n*6*15 + Math.max(n-1,1)*12*40 + n*Math.floor(n/2)*25 + 24*5 || 1
    return { kp: Math.min(1, kp_raw / kp_max), src: useScoreMidi ? 'midi' : 'pyin' }
  }

  // ── Chroma fallback ──
  const cos = chromaCos(theme.features.chroma_chromatic, seg.features.chroma_chromatic)
  return { kp: Math.min(1, (1 - cos) * 1.5), src: 'chroma' }
}

/**
 * kt — Temporal penalty (Almada §3.3)
 * Primary: compressed.onset_count[64] frame comparison (L1 distance on rhythm profile)
 * + scalar supplements (onset_density, rhythm_regularity, tempo)
 */
function computeKt(theme: Segment, seg: Segment): { kt: number; src: 'onset_count' | 'scalars' } {
  const oc_t = theme.features.compressed.onset_count
  const oc_v = seg.features.compressed.onset_count

  if (oc_t && oc_v && oc_t.length > 0) {
    const n = Math.min(oc_t.length, oc_v.length)
    const maxVal = Math.max(...oc_t.slice(0,n), ...oc_v.slice(0,n), 1)
    // L1 normalised distance = IOI profile difference (maps to Σv2/wt IOI component)
    const profile_diff = oc_t.slice(0,n).reduce((s, v, i) => s + Math.abs(v - oc_v[i]) / maxVal, 0) / n

    // Onset density ratio (maps to note duration v1 component)
    const od_t = theme.features.onset_density
    const od_v = seg.features.onset_density
    const od_diff = Math.abs(od_t - od_v) / Math.max(od_t, od_v, 0.01)

    // Rhythm regularity (maps to metric contour v3 component)
    const rr_t = theme.features.rhythm_regularity ?? 0.5
    const rr_v = seg.features.rhythm_regularity ?? 0.5
    const rr_diff = Math.abs(rr_t - rr_v)

    // Tempo (maps to temporal span v4)
    const tm_t = theme.features.tempo
    const tm_v = seg.features.tempo
    const tm_diff = Math.abs(tm_t - tm_v) / Math.max(tm_t, tm_v, 1)

    // Weights inspired by wt=[15,45,30,10]:
    //  od → v1 (15%), profile → v2 (45%), rr → v3 (30%), tm → v4 (10%)
    const kt = Math.min(1, 0.15*od_diff + 0.45*profile_diff + 0.30*rr_diff + 0.10*tm_diff)
    return { kt, src: 'onset_count' }
  }

  // ── Scalar-only fallback ──
  const od_t = theme.features.onset_density
  const od_v = seg.features.onset_density
  const rr_t = theme.features.rhythm_regularity ?? 0.5
  const rr_v = seg.features.rhythm_regularity ?? 0.5
  const tm_t = theme.features.tempo
  const tm_v = seg.features.tempo
  const kt = Math.min(1,
    0.45 * Math.abs(od_t - od_v) / Math.max(od_t, od_v, 0.01) +
    0.35 * Math.abs(rr_t - rr_v) +
    0.20 * Math.abs(tm_t - tm_v) / Math.max(tm_t, tm_v, 1)
  )
  return { kt, src: 'scalars' }
}

/**
 * kh — Harmonic penalty (Almada §3.4)
 * Uses chroma_chromatic (12-dim) + key detection from pitch_contour / dominant_pitch.
 * wh = [45, 25, 15, 10, 5]
 *
 * Key root / mode source priority:
 *   1. score_tonic_semitone / score_is_major  (MIDI score — performance-independent)
 *   2. tonic_semitone / is_major              (pYIN audio-derived)
 *   3. dominant_pitch.cof_index               (chroma fallback)
 */
function computeKh(theme: Segment, seg: Segment): number {
  const WH = [45, 25, 15, 10, 5]
  const pc_t = theme.features.chroma_chromatic
  const pc_v = seg.features.chroma_chromatic

  const cofToSemitone = (cof: number) => (cof * 7) % 12
  const pt = theme.features.pitch_contour
  const ps = seg.features.pitch_contour

  // Prefer MIDI-score tonic → pYIN tonic → chroma fallback
  const root_t = pt?.score_tonic_semitone
    ?? pt?.tonic_semitone
    ?? cofToSemitone(theme.features.dominant_pitch.cof_index)
  const root_v = ps?.score_tonic_semitone
    ?? ps?.tonic_semitone
    ?? cofToSemitone(seg.features.dominant_pitch.cof_index)

  // Prefer MIDI-score mode → pYIN mode → default major
  const mode_t = pt?.score_is_major ?? pt?.is_major ?? true
  const mode_v = ps?.score_is_major ?? ps?.is_major ?? true

  // h1: key root within 1 semitone → 0 (same), else 1
  const h1 = Math.min(Math.abs(root_v - root_t), 12 - Math.abs(root_v - root_t)) <= 1 ? 0 : 1
  // h2: mode mismatch
  const h2 = mode_t === mode_v ? 0 : 1

  // Tonic triad pitch classes
  const tonicPcs = (root: number, major: boolean): number[] => [
    root % 12, (root + (major ? 4 : 3)) % 12, (root + 7) % 12
  ]
  const domPcs = (root: number): number[] =>
    [(root+7)%12, (root+11)%12, (root+2)%12]

  const tpc_t = tonicPcs(root_t, mode_t)
  const tpc_v = tonicPcs(root_v, mode_v)

  // h3: tonic function proportion difference > 0.15
  const tProp = (pc: number[], pcs: number[]) => pcs.reduce((s, p) => s + pc[p], 0)
  const h3 = Math.abs(tProp(pc_t, tpc_t) - tProp(pc_v, tpc_v)) > 0.15 ? 1 : 0

  // h4: dominant function proportion difference > 0.15
  const h4 = Math.abs(tProp(pc_t, domPcs(root_t)) - tProp(pc_v, domPcs(root_v))) > 0.15 ? 1 : 0

  // h5: chroma cosine similarity < 0.85
  const h5 = chromaCos(pc_t, pc_v) >= 0.85 ? 0 : 1

  const vh = [h1, h2, h3, h4, h5]
  return vh.reduce((s, v, i) => s + v * WH[i], 0) / 100
}

/** Map penalty k → similarity band (Almada Table 1.1, π/8 increments) */
function similarityBand(k: number): string {
  if (k <= 0) return 'identity'
  const alpha = (Math.atan((1-k)/k) * 180) / Math.PI
  if (alpha > 67.5) return 'high'
  if (alpha > 45.0) return 'medium-high'
  if (alpha > 22.5) return 'medium-low'
  if (alpha > 0)    return 'low'
  return 'null'
}

/** Classify dominant domain */
function varType(kp: number, kt: number, kh: number): string {
  const vals: Record<string,number> = { melodic: kp, rhythmic: kt, harmonic: kh }
  const dom = Object.entries(vals).sort((a,b) => b[1]-a[1])[0][0]
  const sec = Object.values(vals).sort((a,b) => b-a)[1]
  if (vals[dom] - sec < 0.06) return 'hybrid'
  return dom
}

/** Compute all MDA segments from PieceData */
function computeMda(data: PieceData): MdaSegment[] {
  const segs = data.segments
  const theme = segs[0]
  return segs.map((seg, i) => {
    if (i === 0) return {
      label: seg.label, kp:0, kt:0, kh:0, k:0, alpha:90,
      band:'identity', type:'reference', kp_src:'pyin', kt_src:'onset_count',
    }
    const { kp, src: kp_src } = computeKp(theme, seg)
    const { kt, src: kt_src } = computeKt(theme, seg)
    const kh = computeKh(theme, seg)
    const k  = (3.5*kp + 5*kt + 1.5*kh) / 10
    const alpha = k > 0 ? (Math.atan((1-k)/k) * 180) / Math.PI : 90
    return {
      label: seg.label,
      kp: Math.round(kp*1000)/1000,
      kt: Math.round(kt*1000)/1000,
      kh: Math.round(kh*1000)/1000,
      k:  Math.round(k *1000)/1000,
      alpha: Math.round(alpha*10)/10,
      band: similarityBand(k),
      type: varType(kp, kt, kh),
      kp_src, kt_src,
    }
  })
}

// ── Derivative Space SVG ──────────────────────────────────────────────────────

function DerivativeSpace({ segs, isDark, lang }: {
  segs: MdaSegment[]; isDark: boolean; lang: Lang
}) {
  const [hov, setHov] = useState<number|null>(null)
  const W=340, H=320, PAD=44

  const PW = W - PAD*2, PH = H - PAD*2
  const px = (k: number) => PAD + k*PW
  // In derivative space: y-axis is similarity (1-k), going up = more similar
  // In SVG coordinates, y=0 is top → invert: more similar = lower SVG y
  // Identity (k=0) → top-left corner; Null (k=1) → right side, bottom
  const py = (k: number) => PAD + k*PH

  const textC = isDark ? '#94a3b8' : '#64748b'
  const axisC = isDark ? '#334155' : '#e2e8f0'

  // Band regions (by k threshold, from top-right corner inward)
  const bands = [
    { maxK:1.00, label:lang==='zh'?'低相似':'Low',     fill:'rgba(239,68,68,0.06)' },
    { maxK:0.707,label:lang==='zh'?'中低':'Med-Low',   fill:'rgba(245,158,11,0.06)' },
    { maxK:0.500,label:lang==='zh'?'中高':'Med-High',  fill:'rgba(99,102,241,0.07)' },
    { maxK:0.293,label:lang==='zh'?'高相似':'High',    fill:'rgba(59,130,246,0.08)' },
  ]

  return (
    <svg width={W} height={H} style={{ display:'block', overflow:'visible' }}>

      {/* Derivative space background triangle: P(0,0)→Q(1,0)→R(0,-1) */}
      {/* In SVG: top-left = identity (0,0), right = full divergence */}
      <polygon
        points={`${PAD},${PAD} ${PAD+PW},${PAD+PH} ${PAD},${PAD+PH}`}
        fill={isDark ? '#0f172a' : '#f8fafc'}
        stroke={axisC} strokeWidth={0.7}
      />

      {/* Band fills — slices parallel to the hypotenuse (x=k line in DS) */}
      {bands.map((bd, bi) => {
        const k0 = bi === 0 ? 1 : bands[bi-1].maxK
        const k1 = bd.maxK
        // Left edge (x=0), right boundary at x=k, y=k (diagonal line)
        return (
          <polygon key={bi}
            points={`${PAD},${py(k0)} ${px(k0)},${py(k0)} ${px(k1)},${py(k1)} ${PAD},${py(k1)}`}
            fill={bd.fill} stroke="none"
          />
        )
      })}

      {/* Band boundary lines (horizontal — since points are on diagonal) */}
      {[0.293, 0.500, 0.707].map(k => (
        <line key={k}
          x1={PAD} y1={py(k)} x2={px(k)} y2={py(k)}
          stroke={axisC} strokeWidth={0.6} strokeDasharray="3 2"
        />
      ))}

      {/* Band labels */}
      {bands.map((bd, bi) => {
        const k0 = bi === 0 ? 1 : bands[bi-1].maxK
        const k_mid = (k0 + bd.maxK) / 2
        return (
          <text key={bi} x={PAD+5} y={py(k_mid)-2}
            fontSize={7} fill={textC} opacity={0.7}>
            {bd.label}
          </text>
        )
      })}

      {/* Axes */}
      <line x1={PAD} y1={PAD} x2={PAD} y2={PAD+PH} stroke={axisC} strokeWidth={1}/>
      <line x1={PAD} y1={PAD+PH} x2={PAD+PW} y2={PAD+PH} stroke={axisC} strokeWidth={1}/>

      {/* k axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map(v => (
        <g key={v}>
          <line x1={px(v)} y1={PAD+PH} x2={px(v)} y2={PAD+PH+4} stroke={axisC} strokeWidth={0.8}/>
          <text x={px(v)} y={PAD+PH+13} textAnchor="middle" fontSize={7} fill={textC}>{v}</text>
        </g>
      ))}

      {/* Axis titles */}
      <text x={PAD+PW/2} y={H-3} textAnchor="middle" fontSize={7.5} fill={textC}>
        {lang==='zh' ? '→ 惩罚值 k（发散度）' : '→ Penalty k (divergence)'}
      </text>
      <text x={10} y={PAD+PH/2} textAnchor="middle" fontSize={7.5} fill={textC}
        transform={`rotate(-90,10,${PAD+PH/2})`}>
        {lang==='zh' ? '↑ 相似度' : '↑ Similarity'}
      </text>

      {/* Variation points */}
      {segs.map((seg, i) => {
        if (seg.type === 'reference') return null
        const x = px(seg.k)
        const y = py(seg.k)    // higher k → lower similarity → lower on plot too
        const col = TYPE_META[seg.type]?.color ?? '#888'
        const isHov = hov === i

        // Tooltip position: avoid right edge
        const tipX = x > PAD + PW*0.6 ? x - 138 : x + 10
        const tipY = Math.max(PAD, Math.min(y - 30, PAD + PH - 68))

        return (
          <g key={i}
            onMouseEnter={() => setHov(i)}
            onMouseLeave={() => setHov(null)}
            style={{ cursor:'pointer' }}>
            {isHov && <circle cx={x} cy={y} r={10} fill={col} fillOpacity={0.15}/>}
            <circle cx={x} cy={y} r={5}
              fill={col} fillOpacity={0.75}
              stroke={isDark?'#1e293b':'#fff'} strokeWidth={1.5}/>
            <text x={x+8} y={y+3} fontSize={7} fontWeight={600} fill={col}>
              {seg.label}
            </text>
            {isHov && (
              <g style={{ pointerEvents:'none' }}>
                <rect x={tipX} y={tipY} width={128} height={70} rx={5}
                  fill={isDark?'#1e293b':'#fff'}
                  stroke={isDark?'#334155':'#e2e8f0'} strokeWidth={0.8}
                  opacity={0.97}/>
                <text x={tipX+8} y={tipY+15} fontSize={9} fontWeight={700} fill={col}>
                  {seg.label} · k={seg.k.toFixed(3)}
                </text>
                <text x={tipX+8} y={tipY+28} fontSize={7.5} fill={textC}>
                  kp={seg.kp.toFixed(3)}  kt={seg.kt.toFixed(3)}
                </text>
                <text x={tipX+8} y={tipY+39} fontSize={7.5} fill={textC}>
                  kh={seg.kh.toFixed(3)}  α={seg.alpha.toFixed(1)}°
                </text>
                <text x={tipX+8} y={tipY+52} fontSize={7.5} fontWeight={600} fill={col}>
                  {TYPE_META[seg.type]?.[lang==='zh'?'labelZh':'label']}
                </text>
                <text x={tipX+8} y={tipY+63} fontSize={6.5} fill={textC} opacity={0.7}>
                  {seg.band} · kp:{seg.kp_src} kt:{seg.kt_src}
                </text>
              </g>
            )}
          </g>
        )
      })}

      {/* Theme at origin */}
      <circle cx={PAD} cy={PAD} r={8}
        fill={TYPE_META.reference.color} fillOpacity={0.7}
        stroke={isDark?'#1e293b':'#fff'} strokeWidth={1.5}/>
      <circle cx={PAD} cy={PAD} r={12} fill="none"
        stroke={TYPE_META.reference.color} strokeWidth={1}
        strokeDasharray="4 2" opacity={0.4}/>
      <text x={PAD+14} y={PAD+4} fontSize={8} fontWeight={700}
        fill={TYPE_META.reference.color}>T</text>
    </svg>
  )
}

// ── Penalty bar ───────────────────────────────────────────────────────────────

function PenaltyBar({ label, value, color }: { label:string; value:number; color:string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5, marginBottom:2 }}>
      <span style={{ width:20, fontSize:8, color:'#94a3b8', textAlign:'right' }}>{label}</span>
      <div style={{ flex:1, height:5, background:'rgba(0,0,0,0.06)', borderRadius:3, overflow:'hidden' }}>
        <div style={{
          width:`${Math.min(100, value*100)}%`, height:'100%',
          background:color, borderRadius:3, transition:'width 0.3s',
        }}/>
      </div>
      <span style={{ width:34, fontSize:8, color:'#64748b', fontFamily:'monospace' }}>
        {value.toFixed(3)}
      </span>
    </div>
  )
}

// ── Domain proportion bar ────────────────────────────────────────────────────

function DomainProportionBar({
  kp, kt, kh, lang, compact = false,
}: { kp:number; kt:number; kh:number; lang:Lang; compact?:boolean }) {
  const sum = kp + kt + kh || 0.001
  const pctP = kp / sum, pctT = kt / sum, pctH = kh / sum
  const h = compact ? 6 : 8
  const fontSize = compact ? 7 : 7.5

  return (
    <div>
      {/* Stacked bar */}
      <div style={{
        display:'flex', height:h, borderRadius:4, overflow:'hidden',
        background:'rgba(0,0,0,0.05)',
      }}>
        <div style={{ width:`${pctP*100}%`, background:'#3b82f6', transition:'width 0.3s' }}/>
        <div style={{ width:`${pctT*100}%`, background:'#f59e0b', transition:'width 0.3s' }}/>
        <div style={{ width:`${pctH*100}%`, background:'#ef4444', transition:'width 0.3s' }}/>
      </div>
      {/* Labels */}
      {!compact && (
        <div style={{ display:'flex', gap:8, marginTop:3 }}>
          {[
            { key:'kp', label: lang==='zh'?'音高':'Pitch', pct:pctP, col:'#3b82f6' },
            { key:'kt', label: lang==='zh'?'节奏':'Rhythm', pct:pctT, col:'#f59e0b' },
            { key:'kh', label: lang==='zh'?'和声':'Harmony', pct:pctH, col:'#ef4444' },
          ].map(d => (
            <span key={d.key} style={{ fontSize, color:d.col, fontVariantNumeric:'tabular-nums' }}>
              {d.label} {Math.round(d.pct*100)}%
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Ternary plot ─────────────────────────────────────────────────────────────
// Corners: kp = top, kt = bottom-left, kh = bottom-right
// Point (p,t,h) normalized → barycentric → Cartesian

function TernaryPlot({ segs, isDark, lang }: {
  segs: MdaSegment[]; isDark: boolean; lang: Lang
}) {
  const [hov, setHov] = useState<number|null>(null)
  const W = 200, H = 174   // approx equilateral: H ≈ W*√3/2
  const PAD = 20

  // Vertex positions in SVG coords
  const vKp = { x: W/2,    y: PAD }          // top
  const vKt = { x: PAD,    y: H - PAD }      // bottom-left
  const vKh = { x: W-PAD,  y: H - PAD }      // bottom-right

  function toXY(p: number, t: number, h: number) {
    const sum = p + t + h || 0.001
    const pn = p/sum, tn = t/sum, hn = h/sum
    return {
      x: pn*vKp.x + tn*vKt.x + hn*vKh.x,
      y: pn*vKp.y + tn*vKt.y + hn*vKh.y,
    }
  }

  const textC = isDark ? '#94a3b8' : '#64748b'
  const axisC = isDark ? '#334155' : '#e2e8f0'
  const bgC   = isDark ? '#0f172a' : '#f8fafc'

  // Centroid (equal mix)
  const centre = toXY(1, 1, 1)

  return (
    <svg width={W} height={H} style={{ display:'block', overflow:'visible' }}>
      {/* Triangle */}
      <polygon
        points={`${vKp.x},${vKp.y} ${vKt.x},${vKt.y} ${vKh.x},${vKh.y}`}
        fill={bgC} stroke={axisC} strokeWidth={0.8}
      />

      {/* Centroid crosshair */}
      <circle cx={centre.x} cy={centre.y} r={2.5}
        fill="none" stroke={axisC} strokeWidth={0.7} strokeDasharray="2 1.5"/>

      {/* Corner labels */}
      <text x={vKp.x} y={vKp.y-5} textAnchor="middle"
        fontSize={7.5} fontWeight={700} fill="#3b82f6">
        {lang==='zh' ? '音高 kp' : 'kp Pitch'}
      </text>
      <text x={vKt.x-3} y={vKt.y+11} textAnchor="end"
        fontSize={7.5} fontWeight={700} fill="#f59e0b">
        {lang==='zh' ? 'kt 节奏' : 'kt Rhythm'}
      </text>
      <text x={vKh.x+3} y={vKh.y+11} textAnchor="start"
        fontSize={7.5} fontWeight={700} fill="#ef4444">
        {lang==='zh' ? 'kh 和声' : 'kh Harmony'}
      </text>

      {/* Grid lines at 1/3 and 2/3 from each vertex */}
      {[1/3, 2/3].map(t => {
        // Lines parallel to each side
        const p1 = toXY(1-t, t, 0), p2 = toXY(1-t, 0, t)   // parallel to kt-kh
        const p3 = toXY(t, 1-t, 0), p4 = toXY(0, 1-t, t)   // parallel to kp-kh
        const p5 = toXY(t, 0, 1-t), p6 = toXY(0, t, 1-t)   // parallel to kp-kt
        return (
          <g key={t}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke={axisC} strokeWidth={0.5} strokeDasharray="2 2"/>
            <line x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y}
              stroke={axisC} strokeWidth={0.5} strokeDasharray="2 2"/>
            <line x1={p5.x} y1={p5.y} x2={p6.x} y2={p6.y}
              stroke={axisC} strokeWidth={0.5} strokeDasharray="2 2"/>
          </g>
        )
      })}

      {/* Variation points */}
      {segs.map((seg, i) => {
        if (seg.type === 'reference') return null
        const pos = toXY(seg.kp, seg.kt, seg.kh)
        const col = kColor(seg.k)
        const isHov = hov === i
        const sum   = seg.kp + seg.kt + seg.kh || 0.001

        // Tooltip: avoid bottom edge
        const tipX = pos.x > W*0.6 ? pos.x - 108 : pos.x + 8
        const tipY = Math.max(PAD, Math.min(pos.y - 20, H - PAD - 60))

        return (
          <g key={i}
            onMouseEnter={() => setHov(i)}
            onMouseLeave={() => setHov(null)}
            style={{ cursor:'pointer' }}>
            {isHov && <circle cx={pos.x} cy={pos.y} r={9} fill={col} fillOpacity={0.15}/>}
            <circle cx={pos.x} cy={pos.y} r={4.5}
              fill={col} fillOpacity={0.8}
              stroke={isDark?'#1e293b':'#fff'} strokeWidth={1.2}/>
            {!isHov && (
              <text x={pos.x+6} y={pos.y+3} fontSize={6.5} fontWeight={600} fill={col}>
                {seg.label}
              </text>
            )}
            {isHov && (
              <g style={{ pointerEvents:'none' }}>
                <rect x={tipX} y={tipY} width={102} height={56} rx={4}
                  fill={isDark?'#1e293b':'#fff'}
                  stroke={isDark?'#334155':'#e2e8f0'} strokeWidth={0.7} opacity={0.97}/>
                <text x={tipX+7} y={tipY+13} fontSize={9} fontWeight={700} fill={col}>
                  {seg.label}
                </text>
                <text x={tipX+7} y={tipY+25} fontSize={7} fill={textC}>
                  {lang==='zh'?'音高':'Pitch'} {Math.round(seg.kp/sum*100)}%
                  {'  '}{lang==='zh'?'节奏':'Rhythm'} {Math.round(seg.kt/sum*100)}%
                </text>
                <text x={tipX+7} y={tipY+36} fontSize={7} fill={textC}>
                  {lang==='zh'?'和声':'Harmony'} {Math.round(seg.kh/sum*100)}%
                </text>
                <text x={tipX+7} y={tipY+48} fontSize={6.5} fill={textC} opacity={0.7}>
                  k={seg.k.toFixed(3)} · α={seg.alpha.toFixed(1)}°
                </text>
              </g>
            )}
          </g>
        )
      })}

      {/* Theme dot at centroid (k=0 has equal 0s — show at centre as reference) */}
      <circle cx={centre.x} cy={centre.y} r={5}
        fill={TYPE_META.reference.color} fillOpacity={0.7}
        stroke={isDark?'#1e293b':'#fff'} strokeWidth={1.2}/>
      <text x={centre.x+7} y={centre.y+3} fontSize={7} fontWeight={700}
        fill={TYPE_META.reference.color}>T</text>
    </svg>
  )
}

// ── MDA Genealogy Tree ────────────────────────────────────────────────────────

interface TreeEdge { from:number; to:number; k:number; kp:number; kt:number; kh:number }

function buildMdaTree(segs: MdaSegment[], data: PieceData): TreeEdge[] {
  const N = data.segments.length
  // Build pairwise k matrix
  const pairs: { kp:number; kt:number; kh:number; k:number }[][] =
    Array.from({ length: N }, () => Array(N).fill({ kp:0, kt:0, kh:0, k:0 }))
  for (let i = 0; i < N; i++)
    for (let j = i+1; j < N; j++) {
      const a = data.segments[i], b = data.segments[j]
      const { kp, src: kp_src } = computeKp(a, b)
      const { kt }               = computeKt(a, b)
      const kh                   = computeKh(a, b)
      const k = (3.5*kp + 5*kt + 1.5*kh) / 10
      const r = { kp: Math.round(kp*1000)/1000, kt: Math.round(kt*1000)/1000,
                  kh: Math.round(kh*1000)/1000, k: Math.round(k*1000)/1000 }
      pairs[i][j] = r; pairs[j][i] = r
      void kp_src // used only to satisfy linter
    }
  // Prim's MST rooted at 0 (Theme)
  const edges: TreeEdge[] = []
  const visited = new Set<number>([0])
  while (visited.size < N) {
    let best = Infinity, bf = 0, bt = -1
    visited.forEach(f => {
      for (let t = 0; t < N; t++) {
        if (visited.has(t)) continue
        if (pairs[f][t].k < best) { best = pairs[f][t].k; bf = f; bt = t }
      }
    })
    if (bt < 0) break
    const p = pairs[bf][bt]
    edges.push({ from: bf, to: bt, k: p.k, kp: p.kp, kt: p.kt, kh: p.kh })
    visited.add(bt)
  }
  return edges
}

function MdaTree({ data, segs, isDark, lang }: {
  data: PieceData; segs: MdaSegment[]; isDark: boolean; lang: Lang
}) {
  const [hov, setHov] = useState<number|null>(null)
  const edges = useMemo(() => buildMdaTree(segs, data), [segs, data])

  const N = data.segments.length

  // Build tree structure
  const childrenOf: Record<number,number[]> = {}
  const parentOf:   Record<number,number>   = {}
  const parentEdge: Record<number,TreeEdge> = {}
  edges.forEach(e => {
    if (!childrenOf[e.from]) childrenOf[e.from] = []
    childrenOf[e.from].push(e.to)
    parentOf[e.to]   = e.from
    parentEdge[e.to] = e
  })

  // BFS depth
  const depthOf: Record<number,number> = { 0: 0 }
  const q = [0]
  while (q.length) {
    const cur = q.shift()!;
    (childrenOf[cur]||[]).forEach(c => { depthOf[c] = depthOf[cur]+1; q.push(c) })
  }
  const maxDepth = Math.max(0, ...Object.values(depthOf))

  // Reingold-Tilford layout
  const NODE_W = 38, GAP = 12, MARGIN = 28, ROW_H = Math.max(60, Math.min(90, 380/Math.max(maxDepth,1)))
  const subtreeW: Record<number,number> = {}
  function calcW(n: number): number {
    const ch = childrenOf[n]||[]
    if (!ch.length) { subtreeW[n]=NODE_W; return NODE_W }
    const tot = ch.reduce((s,c) => s+calcW(c), 0) + (ch.length-1)*GAP
    subtreeW[n] = Math.max(NODE_W, tot); return subtreeW[n]
  }
  calcW(0)
  const SVG_W = Math.max(480, (subtreeW[0]??NODE_W) + MARGIN*2)
  const SVG_H = (maxDepth+1)*ROW_H + 52
  const nx: Record<number,number> = {}, ny: Record<number,number> = {}
  function layout(n: number, left: number) {
    const w = subtreeW[n]??NODE_W
    nx[n] = left + w/2; ny[n] = 32 + depthOf[n]*ROW_H
    let cx = left;
    (childrenOf[n]||[]).forEach(c => { layout(c, cx); cx += (subtreeW[c]??NODE_W)+GAP })
  }
  layout(0, MARGIN)

  const textC = isDark ? '#94a3b8' : '#64748b'
  const axisC = isDark ? '#1e293b' : '#f1f5f9'

  return (
    <div>
      <div style={{
        fontSize:8, fontWeight:600, color:textC,
        textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:6,
      }}>
        {lang==='zh' ? ' MDA 派生树 · Prim MST (k 值距离)' : ' MDA Derivation Tree · Prim MST (penalty k)'}
      </div>

      <div style={{ overflowX:'auto' }}>
        <svg width={SVG_W} height={SVG_H} style={{ display:'block', overflow:'visible' }}>

          {/* Generation bands */}
          {Array.from({ length: maxDepth+1 }, (_,d) => {
            const by = 32 + d*ROW_H - ROW_H*0.44
            return (
              <g key={d}>
                <rect x={4} y={by} width={SVG_W-8} height={ROW_H} rx={4}
                  fill={d%2===0 ? (isDark?'#0f172a30':'#f8fafc60') : 'transparent'}/>
                <text x={8} y={by+11} fontSize={7} fill={isDark?'#334155':'#cbd5e1'}>
                  {d===0 ? (lang==='zh'?'Gen 0 · 主题':'Gen 0 · Theme') : `Gen ${d}`}
                </text>
              </g>
            )
          })}

          {/* Edges */}
          {edges.map((e, ei) => {
            const fx=nx[e.from], fy=ny[e.from]+(e.from===0?12:9)
            const tx=nx[e.to],   ty=ny[e.to]-9
            const midY=(fy+ty)/2
            const col=kColor(e.k)
            const sw=0.7+e.k*3.2
            const isHov=hov===e.to||hov===e.from
            const pathD=`M${fx.toFixed(1)},${fy.toFixed(1)} C${fx.toFixed(1)},${midY.toFixed(1)} ${tx.toFixed(1)},${midY.toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`
            return (
              <g key={ei}>
                <path d={pathD} stroke={col} strokeWidth={isHov?sw+1:sw}
                  fill="none" opacity={isHov?0.9:0.55}/>
                <text x={(fx+tx)/2+4} y={(fy+ty)/2} fontSize={6.5} fill={col} opacity={0.85}>
                  k={e.k.toFixed(2)}
                </text>
              </g>
            )
          })}

          {/* Nodes — circles + labels only, no tooltip here */}
          {data.segments.map((seg, i) => {
            const x=nx[i]??SVG_W/2, y=ny[i]??32
            const isTheme=i===0, r=isTheme?12:9
            const pe=parentEdge[i]??null
            const col=isTheme ? TYPE_META.reference.color : (pe ? kColor(pe.k) : textC)
            const isHov=hov===i

            return (
              <g key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)}
                style={{ cursor:'pointer' }}>
                {isTheme && (
                  <circle cx={x} cy={y} r={r+5} fill="none"
                    stroke={col} strokeWidth={1.5} strokeDasharray="4 2" opacity={0.5}/>
                )}
                {isHov && (
                  <circle cx={x} cy={y} r={r+4} fill="none"
                    stroke={col} strokeWidth={1.5} opacity={0.4}/>
                )}
                <circle cx={x} cy={y} r={r}
                  fill={col} fillOpacity={0.2}
                  stroke={col} strokeWidth={isTheme?2:1.4}/>
                <text x={x} y={y+3.5} textAnchor="middle"
                  fontSize={isTheme?9:7.5} fontWeight={700} fill={col}>
                  {seg.label}
                </text>
              </g>
            )
          })}

          {/* Tooltip layer — rendered last so it always sits on top */}
          {hov !== null && (() => {
            const i=hov
            const seg=data.segments[i]
            if (!seg) return null
            const x=nx[i]??SVG_W/2, y=ny[i]??32
            const isTheme=i===0, r=isTheme?12:9
            const pe=parentEdge[i]??null
            const col=isTheme ? TYPE_META.reference.color : (pe ? kColor(pe.k) : textC)
            const mdaSeg=segs[i]
            const tipW=160, tipH=isTheme?44:88
            const tipX=Math.max(4, x>SVG_W*0.62 ? x-tipW-r-4 : x+r+6)
            const tipY=Math.max(4, Math.min(y-tipH/2, SVG_H-tipH-4))
            return (
              <g style={{ pointerEvents:'none' }}>
                <rect x={tipX} y={tipY} width={tipW} height={tipH} rx={5}
                  fill={isDark?'#1e293b':'#fff'}
                  stroke={isDark?'#334155':'#e2e8f0'} strokeWidth={0.8} opacity={0.97}/>
                <text x={tipX+8} y={tipY+14} fontSize={9} fontWeight={700} fill={col}>
                  {seg.label}
                </text>
                {!isTheme && pe ? (
                  <>
                    <text x={tipX+8} y={tipY+28} fontSize={7} fill={textC}>
                      {lang==='zh'?'祖代':'Parent'}: {data.segments[parentOf[i]]?.label ?? 'T'}
                      {'  '}k={pe.k.toFixed(3)}{'  '}α={mdaSeg?.alpha.toFixed(1) ?? '—'}°
                    </text>
                    <text x={tipX+8} y={tipY+40} fontSize={7} fill={textC}>
                      kp={pe.kp.toFixed(3)}  kt={pe.kt.toFixed(3)}  kh={pe.kh.toFixed(3)}
                    </text>
                    {(() => {
                      const sum=pe.kp+pe.kt+pe.kh||0.001
                      const bx=tipX+8, by=tipY+48, bw=tipW-18, bh=5
                      return (
                        <>
                          <rect x={bx} y={by} width={bw} height={bh} rx={2}
                            fill={isDark?'#334155':'#e2e8f0'}/>
                          <rect x={bx} y={by} width={pe.kp/sum*bw} height={bh} rx={2} fill="#3b82f6"/>
                          <rect x={bx+pe.kp/sum*bw} y={by} width={pe.kt/sum*bw} height={bh} fill="#f59e0b"/>
                          <rect x={bx+(pe.kp+pe.kt)/sum*bw} y={by} width={pe.kh/sum*bw} height={bh} rx={2} fill="#ef4444"/>
                          <text x={bx} y={by+14} fontSize={6} fill="#3b82f6">
                            {lang==='zh'?'音高':'P'} {Math.round(pe.kp/sum*100)}%
                          </text>
                          <text x={bx+bw*0.38} y={by+14} fontSize={6} fill="#f59e0b">
                            {lang==='zh'?'节奏':'R'} {Math.round(pe.kt/sum*100)}%
                          </text>
                          <text x={bx+bw*0.72} y={by+14} fontSize={6} fill="#ef4444">
                            {lang==='zh'?'和声':'H'} {Math.round(pe.kh/sum*100)}%
                          </text>
                          {mdaSeg && (
                            <text x={tipX+8} y={tipY+82} fontSize={6.5} fill={textC} opacity={0.7}>
                              {lang==='zh'?'与主题':'vs T'}: k={mdaSeg.k.toFixed(3)} · {mdaSeg.band}
                            </text>
                          )}
                        </>
                      )
                    })()}
                  </>
                ) : (
                  <text x={tipX+8} y={tipY+30} fontSize={7} fill={textC}>
                    {lang==='zh' ? 'Grundgestalt · 根节点' : 'Grundgestalt · root'}
                  </text>
                )}
              </g>
            )
          })()}
        </svg>
      </div>

      {/* Legend */}
      <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginTop:6, alignItems:'flex-start' }}>
        {/* Edge color scale */}
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <span style={{ fontSize:7.5, color:textC, fontWeight:600 }}>
            {lang==='zh' ? '连线颜色 / 粗细 → 两段之间的惩罚值 k' : 'Line color / thickness → penalty k between two segments'}
          </span>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            {[
              { col:'#10b981', sw:1.2, label: lang==='zh' ? 'k < 0.25  极相似' : 'k < 0.25  very similar' },
              { col:'#f59e0b', sw:2.0, label: lang==='zh' ? '0.25–0.45  较相似' : '0.25–0.45  similar' },
              { col:'#f97316', sw:2.8, label: lang==='zh' ? '0.45–0.65  中等差异' : '0.45–0.65  moderate' },
              { col:'#ef4444', sw:3.8, label: lang==='zh' ? 'k > 0.65  差异大' : 'k > 0.65  divergent' },
            ].map(b => (
              <div key={b.col} style={{ display:'flex', alignItems:'center', gap:4 }}>
                <svg width={24} height={10} style={{ flexShrink:0 }}>
                  <line x1={1} y1={5} x2={23} y2={5} stroke={b.col} strokeWidth={b.sw}/>
                </svg>
                <span style={{ fontSize:7, color:b.col, fontWeight:600 }}>{b.label}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Hover hint */}
        <div style={{
          fontSize:7.5, color:textC, paddingLeft:8,
          borderLeft:`1px solid ${isDark?'#334155':'#e2e8f0'}`,
          lineHeight:1.7,
        }}>
          {lang==='zh'
            ? '悬停节点 → 查看该变奏与父节点的 kp / kt / kh 详情\n悬停连线 → 显示音高 / 节奏 / 和声三域比例条'
            : 'Hover a node → see kp / kt / kh detail vs. parent\nHover a line → show pitch / rhythm / harmony proportion bar'}
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function MdaAnalysisPage({ data, theme, isDark, lang }: Props) {
  const segs = useMemo(() => computeMda(data), [data])

  return (
    <div style={{ fontFamily: theme.fontFamily, padding: '10px 14px' }}>
      <MdaTree data={data} segs={segs} isDark={isDark} lang={lang} />
    </div>
  )
}
