/**
 * MIDIAnalysisPage
 * ─────────────────
 * Fetches /api/midi/{file_name}, which fuzzy-matches the piece to a real
 * .mid file in TV_MIDI/ and returns per-variation statistics for
 * 5 structural dimensions:
 *
 *  ① Structural Skeleton   — variation timeline with A/B sections
 *  ② Melodic Contour       — mean top-voice pitch + range bars
 *  ③ Interval Motion       — step / skip / leap stacked bars
 *  ④ Harmonic Function     — tonic / dominant / subdominant weights
 *  ⑤ Rhythmic Ratios       — note-value distribution stacked bars
 *  ⑥ Symbolic Dynamics     — mean velocity bars with ±std error lines
 */

import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import type { PieceData } from '../types/features'
import type { getTheme } from '../theme'
import type { Lang } from '../App'
import { fetchMidiAnalysis } from '../api/pieceApi'
import type { MidiAnalysisData } from '../api/pieceApi'

interface Props {
  data:   PieceData
  theme:  ReturnType<typeof getTheme>
  isDark: boolean
  lang:   Lang
}

// ── TAB20 palette (13 colours, same as matplotlib tab20 sampled) ──────
const TAB20 = [
  '#1f77b4','#aec7e8','#ff7f0e','#ffbb78','#2ca02c',
  '#98df8a','#d62728','#ff9896','#9467bd','#c5b0d5',
  '#8c564b','#c49c94','#e377c2',
]

// ── Shared layout constants ──────────────────────────────────────────
const CHART_W    = 780
const BAR_W_FRAC = 0.72   // bar width as fraction of slot
const LABEL_H    = 28     // space below bars for x-axis labels

// ── Tiny helpers ─────────────────────────────────────────────────────
const PC_NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B']

function midi2name(m: number): string {
  return `${PC_NAMES[m % 12]}${Math.floor(m / 12) - 1}`
}

/** Return the harmonic-function colour for pitch-class `pc` in a given key. */
function pcFuncColor(pc: number, root: number, mode: string): string {
  const R = ((root % 12) + 12) % 12
  if (mode === 'major') {
    const tI  = [R, (R+4)%12, (R+7)%12]             // I  triad
    const tV  = [(R+7)%12, (R+11)%12, (R+2)%12]     // V  triad
    const tIV = [(R+5)%12, (R+9)%12,  R]             // IV triad
    if (tI.includes(pc))  return '#3B82F6'   // blue   – tonic
    if (tV.includes(pc))  return '#EF4444'   // red    – dominant
    if (tIV.includes(pc)) return '#22C55E'   // green  – subdominant
    return '#CBD5E1'                          // grey   – chromatic
  } else {
    const tI  = [R, (R+3)%12, (R+7)%12]             // i   triad
    const tV  = [(R+7)%12, (R+11)%12, (R+2)%12]     // V   triad (harmonic minor)
    const tIV = [(R+5)%12, (R+8)%12,  R]             // iv  triad
    if (tI.includes(pc))  return '#818CF8'   // indigo – tonic (minor)
    if (tV.includes(pc))  return '#F97316'   // orange – dominant (minor)
    if (tIV.includes(pc)) return '#0EA5E9'   // sky    – subdominant (minor)
    return '#CBD5E1'
  }
}

function velColor(v: number): string {
  if (v < 50) return '#93C5FD'
  if (v < 65) return '#6EE7B7'
  if (v < 80) return '#FBBF24'
  if (v < 95) return '#FB923C'
  return '#F87171'
}

// ── Insight box ───────────────────────────────────────────────────────
function Insight({ lines }: { lines: string[] }) {
  return (
    <div style={{
      marginTop: 12,
      padding: '8px 12px',
      background: '#F8FAFF',
      borderLeft: '3px solid #C7D2FE',
      borderRadius: '0 6px 6px 0',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      {lines.map((line, i) => (
        <p key={i} style={{ margin: 0, fontSize: 11.5, color: '#475569', lineHeight: 1.65 }}>
          {line}
        </p>
      ))}
    </div>
  )
}

// ── Data-driven insight generators ───────────────────────────────────
function argMax(arr: number[]): number {
  return arr.reduce((best, v, i) => v > arr[best] ? i : best, 0)
}
function argMin(arr: number[]): number {
  return arr.reduce((best, v, i) => v < arr[best] ? i : best, 0)
}
function pct(v: number) { return `${Math.round(v * 100)}%` }

// Bilingual helper — returns zh when lang='zh', else en
function t(lang: Lang, zh: string, en: string) { return lang === 'zh' ? zh : en }

function shortLabel(labels: string[], i: number) {
  return labels[i].replace('Var.', 'Var. ')
}

function insightStructure(d: MidiAnalysisData, lang: Lang): string[] {
  const n = d.var_labels!.length - 1
  return [
    t(lang,
      `全曲共 ${d.total_bars} 小节，${d.beats_per_bar}/4 拍，由主题与 ${n} 个变奏组成。每个色块代表一个段落（16 小节），内部白线将其分为 A 段（第 1–8 小节）与 B 段（第 9–16 小节）。`,
      `The piece spans ${d.total_bars} bars in ${d.beats_per_bar}/4 time, organised as the Theme followed by ${n} variations. Each block is 16 bars, split by a white divider into an A-section (bars 1–8) and a B-section (bars 9–16).`),
    t(lang,
      `各段落的颜色在下方所有六张图中保持一致，便于跨维度追踪同一变奏的特征。`,
      `The colour coding is consistent across all six panels below, so you can track the same variation across every analytical dimension simultaneously.`),
  ]
}

function insightMelody(d: MidiAnalysisData, lang: Lang): string[] {
  const labels   = d.var_labels!
  const means    = d.mel_mean!
  const lo       = d.mel_lo!
  const hi       = d.mel_hi!
  const hi_i     = argMax(means)
  const lo_i     = argMin(means)
  const wide_i   = argMax(hi.map((h, i) => h - lo[i]))
  const narrow_i = argMin(hi.map((h, i) => h - lo[i]))
  return [
    t(lang,
      `柱高 = 每拍最高声部的平均音高（MIDI 编号）；误差线覆盖该变奏内最高声部音高的第 10 至第 90 百分位范围。`,
      `Bar height = mean pitch of the highest voice per beat; error bars span the 10th–90th percentile of that voice's range within the variation.`),
    t(lang,
      `${shortLabel(labels, hi_i)} 的平均音高最高（MIDI ${means[hi_i].toFixed(0)}，约 ${midi2name(Math.round(means[hi_i]))}），${shortLabel(labels, lo_i)} 最低（${means[lo_i].toFixed(0)}，约 ${midi2name(Math.round(means[lo_i]))}）。均值偏高通常意味着该变奏以音阶跑动或装饰音为主，旋律线在高音区展开。`,
      `${shortLabel(labels, hi_i)} sits highest on average (MIDI ${means[hi_i].toFixed(0)} ≈ ${midi2name(Math.round(means[hi_i]))}), while ${shortLabel(labels, lo_i)} is lowest (${means[lo_i].toFixed(0)} ≈ ${midi2name(Math.round(means[lo_i]))}). A higher mean typically signals a scale-run or ornamental variation climbing into the treble register.`),
    t(lang,
      `${shortLabel(labels, wide_i)} 的音域跨度最宽（${(hi[wide_i]-lo[wide_i]).toFixed(0)} 个半音），反映出大幅度音程跳进或琶音织体；${shortLabel(labels, narrow_i)} 音域最为集中（${(hi[narrow_i]-lo[narrow_i]).toFixed(0)} 个半音），对应级进或音域固定的织体风格。`,
      `${shortLabel(labels, wide_i)} has the widest melodic spread (${(hi[wide_i]-lo[wide_i]).toFixed(0)} semitones), suggesting large registral leaps or arpeggiation; ${shortLabel(labels, narrow_i)} is the most confined (${(hi[narrow_i]-lo[narrow_i]).toFixed(0)} semitones), pointing to a stepwise or registrally static texture.`),
  ]
}

function insightIntervals(d: MidiAnalysisData, lang: Lang): string[] {
  const labels = d.var_labels!
  const stp    = d.stp_r!
  const lp     = d.lp_r!
  const iv     = d.mean_iv!
  const step_i = argMax(stp)
  const leap_i = argMax(lp)
  const avgStp = stp.reduce((a, b) => a + b, 0) / stp.length
  return [
    t(lang,
      `蓝色 = 级进（≤2 个半音），灰色 = 小跳（3–4 个半音），红色 = 大跳（>4 个半音）。柱顶数字为该变奏的平均音程大小（半音数）。`,
      `Blue = stepwise motion (≤2 semitones), grey = small skips (3–4), red = leaps (>4). The number above each bar is the mean interval size in semitones.`),
    t(lang,
      `${shortLabel(labels, step_i)} 级进比例最高（${pct(stp[step_i])}，平均音程 ${iv[step_i].toFixed(1)} 个半音），典型的音阶跑动或加花装饰变奏；${shortLabel(labels, leap_i)} 大跳最多（${pct(lp[leap_i])}），对应分解和弦或宽音域琶音织体。`,
      `${shortLabel(labels, step_i)} is the most stepwise (${pct(stp[step_i])} steps, mean ${iv[step_i].toFixed(1)} st) — characteristic of scale-passage or ornamentation variations. ${shortLabel(labels, leap_i)} has the most leaps (${pct(lp[leap_i])}) — typical of broken-chord or wide-arpeggio writing.`),
    t(lang,
      `全曲所有变奏的平均级进比例为 ${pct(avgStp)}，${avgStp > 0.5 ? '超过 50%，说明整体以级进为主，旋律线条流畅连贯' : '不足 50%，说明跳进与和弦分解织体在全曲中占主导'}。`,
      `The average step ratio across all variations is ${pct(avgStp)}, which is ${avgStp > 0.5 ? 'above 50% — predominantly conjunct melodic writing throughout' : 'below 50% — disjunct, chord-based textures dominate the set'}.`),
  ]
}

function insightHarmony(d: MidiAnalysisData, lang: Lang): string[] {
  const labels = d.var_labels!
  const modes  = d.key_mode ?? labels.map(() => 'major')
  const roots  = d.key_root ?? labels.map(() => 0)
  const hd     = d.harm_d!
  const ht     = d.harm_t!
  const dom_i  = argMax(hd)
  const ton_i  = argMax(ht)

  const minorSegs = labels.filter((_, i) => modes[i] === 'minor')
  const minorStr  = minorSegs.length > 0 ? minorSegs.join(', ') : t(lang, '无', 'none')

  // Describe unique detected keys (may be all the same)
  const keySet = [...new Set(labels.map((_, i) => PC_NAMES[roots[i]] + (modes[i] === 'major' ? '' : 'm')))]
  const keyDesc = keySet.length === 1 ? keySet[0] : keySet.join(' / ')

  // Stability statistics
  const sims = (d.chroma ?? []).map(ch => {
    const ref = (d.chroma ?? [])[0] ?? []
    const dot  = ch.reduce((s, v, i) => s + v * ref[i], 0)
    const magA = Math.sqrt(ch.reduce((s, v) => s + v * v, 0))
    const magB = Math.sqrt(ref.reduce((s, v) => s + v * v, 0))
    return magA * magB > 0 ? dot / (magA * magB) : 0
  })
  const avgSim    = sims.slice(1).reduce((a, b) => a + b, 0) / Math.max(sims.slice(1).length, 1)
  const minSim_i  = sims.slice(1).reduce((best, v, i) => v < sims[best + 1] ? i : best, 0) + 1
  const maxSim_i  = sims.slice(1).reduce((best, v, i) => v > sims[best + 1] ? i : best, 0) + 1

  return [
    t(lang,
      `每个小图中的灰色虚线底图 = 主题的音级轮廓，即全曲共享的"和声框架"。彩色实线轮廓 = 该变奏的实际音级分布，以主题的最大值归一化，使两者在同一尺度下直接可比。轮廓越贴近灰色底图，说明该变奏对和声框架的保留越忠实；向外突出的方向说明该音级被强化，向内凹陷说明该音级被弱化。底部色条为与主题的余弦相似度。`,
      `The grey dashed silhouette on every panel shows the Theme's pitch-class profile — the shared harmonic framework. The coloured outline is the variation's own profile, both normalised to the Theme's peak, so they are on the same scale. Where the outlines coincide: the framework is preserved. A spike outside the grey = that pitch class is emphasised more than in the theme; a dip inside = it is de-emphasised. The bar below shows cosine similarity to the Theme.`),
    t(lang,
      `整体稳定性：变奏与主题的平均相似度为 ${Math.round(avgSim * 100)}%，${avgSim >= 0.95 ? '说明和声框架在整套变奏中高度稳定——各变奏的音级"骨架"几乎始终与主题重合，变奏的个性体现在织体、节奏和动态，而非和声本身' : '各变奏对和声框架有一定程度的再诠释'}。${shortLabel(labels, minSim_i)} 偏离最大（${Math.round(sims[minSim_i] * 100)}%），${shortLabel(labels, maxSim_i)} 最为接近主题（${Math.round(sims[maxSim_i] * 100)}%）。`,
      `Overall stability: average similarity across variations is ${Math.round(avgSim * 100)} %. ${avgSim >= 0.95 ? "This confirms the harmonic framework is highly stable throughout — the pitch-class 'skeleton' nearly always matches the Theme. Each variation's character comes from texture, rhythm, and dynamics, not harmonic departure." : 'Variations show some degree of harmonic reinterpretation.'} ${shortLabel(labels, minSim_i)} deviates most (${Math.round(sims[minSim_i] * 100)} %), while ${shortLabel(labels, maxSim_i)} stays closest to the Theme (${Math.round(sims[maxSim_i] * 100)} %).`),
    t(lang,
      `调性：${keyDesc}，小调变奏：${minorStr}。${minorSegs.length > 0 ? '小调变奏的轮廓轴线会发生"旋转"——降三音（Eb）和降六音（Ab）的方向出现外突，而升三音（E）方向收缩，这正是大小调转换的音级指纹。' : '全曲保持大调，调性色彩一以贯之。'}`,
      `Key: ${keyDesc}. Minor variations: ${minorStr}. ${minorSegs.length > 0 ? "Minor variations show a characteristic 'rotation' of the outline — the flat-third and flat-sixth directions spike outward while the major-third direction recedes, the unmistakable fingerprint of a mode change." : 'All variations remain in major, maintaining a consistent tonal colour.'}`),
  ]
}

function insightRhythm(d: MidiAnalysisData, lang: Lang): string[] {
  const labels  = d.var_labels!
  const r16     = d.rhy_16th!
  const rQ      = d.rhy_quarter!
  const fast_i  = argMax(r16)
  const slow_i  = argMax(rQ)
  const avgFast = r16.reduce((a, b) => a + b, 0) / r16.length
  return [
    t(lang,
      `蓝色 = 四分音符及更长时值，绿色 = 八分音符，黄色 = 十六分音符，红色 = 三十二分音符及更短时值。`,
      `Blue = quarter notes and longer, green = eighth notes, yellow = sixteenth notes, red = thirty-second notes and shorter.`),
    t(lang,
      `${shortLabel(labels, fast_i)} 节奏最为密集：${pct(r16[fast_i])} 的音符为十六分音符或更短，是典型的快速跑动加花变奏；${shortLabel(labels, slow_i)} 以四分音符为主（${pct(rQ[slow_i])}），节奏宽松，具歌唱性或和声块状织体特征。`,
      `${shortLabel(labels, fast_i)} is the most rhythmically active: ${pct(r16[fast_i])} of its notes are sixteenth notes or shorter — a strong indicator of running-passage ornamentation. In contrast, ${shortLabel(labels, slow_i)} is dominated by quarter-note values (${pct(rQ[slow_i])}), pointing to a lyrical or homophonic texture.`),
    t(lang,
      `全曲十六分音符平均占比为 ${pct(avgFast)}，${avgFast > 0.35 ? '超过三分之一，说明快速音符是这套变奏曲的核心写作语言' : '整体来看慢时值仍占多数，快速音符只出现在特定变奏中'}。`,
      `On average ${pct(avgFast)} of all notes are sixteenth notes, ${avgFast > 0.35 ? 'confirming fast-note writing as the dominant language of this variation set' : 'showing that slower note values still form the bulk of the texture overall'}.`),
  ]
}

function insightDynamics(d: MidiAnalysisData, lang: Lang): string[] {
  const labels = d.var_labels!
  const means  = d.vel_mean!
  const stds   = d.vel_std!
  const loud_i = argMax(means)
  const soft_i = argMin(means)
  const expr_i = argMax(stds)
  const flat_i = argMin(stds)
  function dynWord(v: number) {
    if (lang === 'zh') {
      if (v < 50) return 'pp（很弱）'
      if (v < 65) return 'p（弱）'
      if (v < 80) return 'mp（中弱）'
      if (v < 95) return 'mf（中强）'
      return 'f（强）'
    } else {
      if (v < 50) return 'pp'
      if (v < 65) return 'p'
      if (v < 80) return 'mp'
      if (v < 95) return 'mf'
      return 'f'
    }
  }
  return [
    t(lang,
      `柱高 = 平均 MIDI 力度值（0–127）；误差线为 ±1 标准差。颜色编码力度等级：蓝 = pp，绿 = p，黄 = mp，橙 = mf，红 = f。`,
      `Bar height = mean MIDI velocity (0–127); error bars show ±1 standard deviation. Colour encodes dynamic level: blue = pp, green = p, yellow = mp, orange = mf, red = f.`),
    t(lang,
      `${shortLabel(labels, loud_i)} 是全曲最响的变奏（均值 ${means[loud_i].toFixed(0)}，约 ${dynWord(means[loud_i])}）；${shortLabel(labels, soft_i)} 最轻（${means[soft_i].toFixed(0)}，约 ${dynWord(means[soft_i])}）。段落间明显的力度落差，往往对应乐谱中作曲家标注的 p / f 指令。`,
      `${shortLabel(labels, loud_i)} is the loudest variation (mean vel ${means[loud_i].toFixed(0)}, ~${dynWord(means[loud_i])}); ${shortLabel(labels, soft_i)} is the softest (${means[soft_i].toFixed(0)}, ~${dynWord(means[soft_i])}). Large velocity gaps often correspond to written p/f markings in the score.`),
    t(lang,
      `${shortLabel(labels, expr_i)} 内部力度变化最剧烈（σ = ${stds[expr_i].toFixed(1)}），暗示渐强或渐弱的表情设计；${shortLabel(labels, flat_i)} 力度最均匀（σ = ${stds[flat_i].toFixed(1)}），整个变奏维持在单一力度层次上。`,
      `${shortLabel(labels, expr_i)} shows the greatest dynamic contrast (σ = ${stds[expr_i].toFixed(1)}), suggesting expressive crescendo/decrescendo shaping. ${shortLabel(labels, flat_i)} is the most dynamically uniform (σ = ${stds[flat_i].toFixed(1)}), maintaining a single dynamic level throughout.`),
  ]
}

// ── Panel card ────────────────────────────────────────────────────────
function Panel({ title, accent, children }: {
  title: string; accent: string; children: ReactNode
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid rgba(0,0,0,0.07)',
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 16,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '9px 14px 8px',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}>
        <div style={{ width: 3, height: 20, borderRadius: 2, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: '#0F172A' }}>{title}</span>
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  )
}

// ── Legend item ───────────────────────────────────────────────────────
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                   marginRight: 12, fontSize: 10, color: '#64748B' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2,
                     background: color, display: 'inline-block', flexShrink: 0 }} />
      {label}
    </span>
  )
}

// ── X-axis label row ──────────────────────────────────────────────────
function XLabels({ labels, W, padL, padR }: {
  labels: string[]; W: number; padL: number; padR: number
}) {
  const n   = labels.length
  const cw  = W - padL - padR
  const slot = cw / n
  return (
    <svg width={W} height={LABEL_H} style={{ display: 'block', marginTop: -1 }}>
      {labels.map((lbl, i) => (
        <text key={i}
          x={padL + (i + 0.5) * slot}
          y={LABEL_H - 4}
          textAnchor="middle"
          fontSize={lbl.length > 5 ? 7 : 8}
          fill="#64748B"
        >
          {lbl.replace('Var.', 'V').replace('Theme', 'T')}
        </text>
      ))}
    </svg>
  )
}

// ════════════════════════════════════════════════════════════════════
// ① Structure timeline
// ════════════════════════════════════════════════════════════════════
function StructureChart({ d }: { d: MidiAnalysisData }) {
  const labels    = d.var_labels!
  const starts    = d.var_starts!
  const ends      = d.var_ends!
  const totalBars = d.total_bars!
  const W = CHART_W, H = 52, PL = 0, PR = 0

  return (
    <svg width={W} height={H + LABEL_H} style={{ display: 'block' }}>
      {labels.map((lbl, i) => {
        const s   = starts[i]
        const e   = ends[i]
        const x   = PL + (s / totalBars) * (W - PL - PR)
        const w   = ((e - s) / totalBars) * (W - PL - PR)
        const mid = (s + e) / 2
        const mx  = PL + (mid / totalBars) * (W - PL - PR)
        const hMid = PL + ((s + (e - s) / 2) / totalBars) * (W - PL - PR)
        return (
          <g key={i}>
            {/* Full block */}
            <rect x={x + 1} y={4} width={Math.max(0, w - 2)} height={32}
              rx={3} fill={TAB20[i % TAB20.length]} opacity={0.88} />
            {/* A/B divider */}
            <line x1={hMid} x2={hMid} y1={4} y2={36}
              stroke="white" strokeWidth={1} opacity={0.55} />
            {/* Label */}
            {w > 22 && (
              <text x={mx} y={24} textAnchor="middle" fontSize={6.5}
                fontWeight="bold" fill="white">
                {lbl.replace('Var.', 'V').replace('Theme', 'T')}
              </text>
            )}
            {/* A / B sub-labels */}
            {w > 36 && (
              <>
                <text x={(x + hMid) / 2 + x / 2 - (x + hMid) / 4}
                  y={41} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.7)">A</text>
                <text x={(hMid + x + w - 1) / 2}
                  y={41} textAnchor="middle" fontSize={6} fill="rgba(255,255,255,0.45)">B</text>
              </>
            )}
          </g>
        )
      })}
      {/* Bar label row */}
      <text x={0} y={H + LABEL_H - 4} fontSize={7} fill="#94A3B8">
        0
      </text>
      <text x={W} y={H + LABEL_H - 4} textAnchor="end" fontSize={7} fill="#94A3B8">
        {totalBars} bars
      </text>
    </svg>
  )
}

// ════════════════════════════════════════════════════════════════════
// ② Melodic Contour  — mean pitch bar + range error lines
// ════════════════════════════════════════════════════════════════════
function MelodyChart({ d }: { d: MidiAnalysisData }) {
  const n      = d.var_labels!.length
  const means  = d.mel_mean!
  const lo     = d.mel_lo!
  const hi     = d.mel_hi!
  const W = CHART_W, H = 120, PL = 30, PR = 8
  const cw = W - PL - PR
  const slot = cw / n
  const bw   = slot * BAR_W_FRAC

  // Pitch range: clamp to roughly C3–C6 (48–84)
  const minP = 46, maxP = 90
  const py = (p: number) => H - 4 - ((p - minP) / (maxP - minP)) * (H - 16)

  return (
    <>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Y grid + labels at C3/C4/C5/C6 */}
        {[48, 60, 72, 84].map(pitch => (
          <g key={pitch}>
            <line x1={PL} x2={W - PR} y1={py(pitch)} y2={py(pitch)}
              stroke="#E2E8F0" strokeWidth={0.8} />
            <text x={PL - 3} y={py(pitch) + 3} textAnchor="end"
              fontSize={7} fill="#94A3B8">{midi2name(pitch)}</text>
          </g>
        ))}

        {/* Bars + error lines */}
        {means.map((m, i) => {
          const x  = PL + i * slot + (slot - bw) / 2
          const yM = py(m)
          const yL = py(lo[i])
          const yH = py(hi[i])
          const bH = Math.max(1, yL - yM)   // bar goes from mean up to lo (lower pitch = higher y)
          const fill = TAB20[i % TAB20.length]
          return (
            <g key={i}>
              {/* Bar: base at C4 (60), or base of chart */}
              <rect x={x} y={yM} width={bw} height={bH}
                fill={fill} opacity={0.82} rx={2} />
              {/* Error line (10th–90th) */}
              <line x1={x + bw / 2} x2={x + bw / 2} y1={yH} y2={yL}
                stroke="#1E40AF" strokeWidth={1.2} opacity={0.45} />
              <line x1={x + bw / 4} x2={x + bw * 3 / 4} y1={yH} y2={yH}
                stroke="#1E40AF" strokeWidth={1} opacity={0.45} />
              <line x1={x + bw / 4} x2={x + bw * 3 / 4} y1={yL} y2={yL}
                stroke="#1E40AF" strokeWidth={1} opacity={0.45} />
              {/* Mean label */}
              <text x={x + bw / 2} y={yM - 2} textAnchor="middle"
                fontSize={6} fill="#475569">{m.toFixed(0)}</text>
            </g>
          )
        })}
      </svg>
      <XLabels labels={d.var_labels!} W={W} padL={PL} padR={PR} />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// Generic stacked bar chart
// ════════════════════════════════════════════════════════════════════
interface StackLayer {
  values: number[]
  color:  string
  label:  string
}

function StackedBarChart({ layers, labels, H = 100 }: {
  layers: StackLayer[]; labels: string[]; H?: number
}) {
  const n  = labels.length
  const W  = CHART_W, PL = 30, PR = 8
  const cw = W - PL - PR
  const slot = cw / n
  const bw   = slot * BAR_W_FRAC

  const chartH = H

  return (
    <>
      <svg width={W} height={chartH} style={{ display: 'block' }}>
        {/* Y grid at 25/50/75/100% */}
        {[0.25, 0.5, 0.75, 1.0].map(t => {
          const y = chartH - 4 - t * (chartH - 14)
          return (
            <g key={t}>
              <line x1={PL} x2={W - PR} y1={y} y2={y}
                stroke="#E2E8F0" strokeWidth={0.8} />
              <text x={PL - 3} y={y + 3} textAnchor="end"
                fontSize={7} fill="#94A3B8">{Math.round(t * 100)}%</text>
            </g>
          )
        })}

        {Array.from({ length: n }, (_, i) => {
          const x = PL + i * slot + (slot - bw) / 2
          let bottom = 0
          return (
            <g key={i}>
              {layers.map((layer, li) => {
                const v  = layer.values[i] ?? 0
                const y0 = chartH - 4 - (bottom + v) * (chartH - 14)
                const bH = v * (chartH - 14)
                bottom += v
                return (
                  <g key={li}>
                    <rect x={x} y={y0} width={bw} height={Math.max(0, bH)}
                      fill={layer.color} opacity={0.88} rx={li === 0 ? 2 : 0} />
                    {bH > 14 && (
                      <text x={x + bw / 2} y={y0 + bH / 2 + 3}
                        textAnchor="middle" fontSize={6} fill="white" fontWeight="bold">
                        {Math.round(v * 100)}%
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      <XLabels labels={labels} W={W} padL={PL} padR={PR} />
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// ④ Chroma fingerprint — radar + mode strip
// ════════════════════════════════════════════════════════════════════
function ChromaChart({ d, lang }: { d: MidiAnalysisData; lang: Lang }) {
  const labels  = d.var_labels!
  const chromas = d.chroma!
  const roots   = d.key_root!
  const modes   = d.key_mode!
  const n       = labels.length

  // ── Stability helpers ──────────────────────────────────────────────
  const theme = chromas[0]                          // reference = Theme
  // Scale every radar to the THEME's max → theme fills the guide circle,
  // variations that deviate will protrude outside or recede inside it.
  const themeMax = Math.max(...theme, 0.01)

  function cosSim(a: number[], b: number[]): number {
    const dot  = a.reduce((s, v, i) => s + v * b[i], 0)
    const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
    const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
    return magA * magB > 0 ? dot / (magA * magB) : 0
  }
  const sims = chromas.map(ch => cosSim(ch, theme))  // 0-1 per segment

  // ── Layout ───────────────────────────────────────────────────────
  const W      = CHART_W
  const MODE_H = 14    // key badge
  const RADAR_H = 74   // polygon area
  const SIM_H   = 10   // similarity bar row
  const LBL_H2  = 18   // x-label
  const TOTAL_H = MODE_H + RADAR_H + SIM_H + LBL_H2

  const slotW = W / n
  const R     = Math.min(slotW * 0.41, 26)
  const INNER = 2.0
  const cy    = MODE_H + RADAR_H * 0.5

  /** Polygon points string for a chroma array, normalised to themeMax. */
  function polyPts(ch: number[], cx: number): string {
    return ch.map((val, pc) => {
      const angle = (pc / 12) * 2 * Math.PI - Math.PI / 2
      const r     = (val / themeMax) * R + INNER
      return `${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`
    }).join(' ')
  }

  return (
    <>
      <svg width={W} height={TOTAL_H} style={{ display: 'block' }}>
        {labels.map((lbl, i) => {
          const cx    = (i + 0.5) * slotW
          const ch    = chromas[i]
          const root  = roots[i]
          const mode  = modes[i]
          const isMaj = mode === 'major'
          const sim   = sims[i]
          const isRef = i === 0   // Theme is the reference

          // Similarity colour: green ≥ 0.97 / yellow ≥ 0.90 / red below
          const simColor = sim >= 0.97 ? '#22C55E' : sim >= 0.90 ? '#FBBF24' : '#EF4444'

          return (
            <g key={i}>
              {/* Key-mode badge */}
              <rect x={i * slotW + 0.5} y={0} width={slotW - 1} height={MODE_H}
                fill={isMaj ? '#EFF6FF' : '#FEF3C7'} rx={2} />
              <text x={cx} y={10} textAnchor="middle" fontSize={6.5}
                fontWeight="bold" fill={isMaj ? '#1D4ED8' : '#B45309'}>
                {PC_NAMES[root]}{isMaj ? '' : 'm'}
              </text>

              {/* Outer guide circle */}
              <circle cx={cx} cy={cy} r={R + INNER}
                fill="none" stroke="#E2E8F0" strokeWidth={0.5} strokeDasharray="2 2" />

              {/* ① Grey silhouette = Theme harmonic framework (shown on every panel) */}
              <polygon points={polyPts(theme, cx)}
                fill="rgba(148,163,184,0.22)"
                stroke="#94A3B8"
                strokeWidth={isRef ? 0 : 0.8}
                strokeDasharray={isRef ? '' : '2 1.5'}
              />

              {/* ② This variation's polygon */}
              <polygon points={polyPts(ch, cx)}
                fill={isRef
                  ? 'rgba(100,116,139,0.30)'
                  : isMaj ? 'rgba(59,130,246,0.12)' : 'rgba(129,140,248,0.12)'}
                stroke={isRef ? '#475569' : isMaj ? '#3B82F6' : '#818CF8'}
                strokeWidth={isRef ? 1.4 : 1.2}
              />

              {/* Centre */}
              <circle cx={cx} cy={cy} r={INNER} fill="#94A3B8" opacity={0.45} />

              {/* Similarity bar (hidden for reference) */}
              <rect x={i * slotW + 2} y={MODE_H + RADAR_H + 1}
                width={slotW - 4} height={SIM_H - 2}
                fill="#F1F5F9" rx={2} />
              {isRef ? (
                <text x={cx} y={MODE_H + RADAR_H + SIM_H - 1}
                  textAnchor="middle" fontSize={5.5} fill="#94A3B8">
                  {t(lang, '基准', 'ref')}
                </text>
              ) : (
                <>
                  <rect x={i * slotW + 2} y={MODE_H + RADAR_H + 1}
                    width={Math.max(0, (slotW - 4) * sim)} height={SIM_H - 2}
                    fill={simColor} rx={2} />
                  <text x={cx} y={MODE_H + RADAR_H + SIM_H - 1}
                    textAnchor="middle" fontSize={5.5}
                    fill={sim >= 0.97 ? '#166534' : sim >= 0.90 ? '#713F12' : '#991B1B'}>
                    {Math.round(sim * 100)}%
                  </text>
                </>
              )}

              {/* Segment label */}
              <text x={cx} y={TOTAL_H - 4} textAnchor="middle"
                fontSize={7} fill="#64748B">
                {lbl.replace('Var.', 'V').replace('Theme', 'T')}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div style={{
        display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap',
        fontSize: 9, color: '#64748B', alignItems: 'center',
      }}>
        <span style={{ color: '#94A3B8' }}>
          {t(lang, 'C↑ 顺时针按半音', 'C↑ clockwise by semitone')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <svg width={16} height={10}>
            <polygon points="8,1 15,9 1,9" fill="rgba(148,163,184,0.3)"
              stroke="#94A3B8" strokeWidth={1} strokeDasharray="2 1.5" />
          </svg>
          {t(lang, '主题（和声框架）', 'Theme (framework)')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <svg width={16} height={10}>
            <polygon points="8,1 15,9 1,9" fill="rgba(59,130,246,0.15)"
              stroke="#3B82F6" strokeWidth={1.2} />
          </svg>
          {t(lang, '各变奏轮廓', 'Variation outline')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 18, height: 5, background: 'linear-gradient(to right,#22C55E,#FBBF24,#EF4444)', borderRadius: 2, display: 'inline-block' }} />
          {t(lang, '相似度 (绿=高，红=偏离)', 'Similarity (green=high, red=deviant)')}
        </span>
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// ⑥ Dynamics — bar + error lines
// ════════════════════════════════════════════════════════════════════
function DynamicsChart({ d, lang }: { d: MidiAnalysisData; lang: Lang }) {
  const n      = d.var_labels!.length
  const means  = d.vel_mean!
  const stds   = d.vel_std!
  const W = CHART_W, H = 110, PL = 30, PR = 40
  const cw   = W - PL - PR
  const slot  = cw / n
  const bw    = slot * BAR_W_FRAC
  const maxV  = 120
  const py    = (v: number) => H - 4 - (v / maxV) * (H - 14)

  // Threshold lines: pp=45, mp=64, f=90
  const thresholds = [{ v: 45, label: 'pp' }, { v: 64, label: 'mp' }, { v: 90, label: 'f' }]

  return (
    <>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Threshold lines */}
        {thresholds.map(({ v, label }) => (
          <g key={label}>
            <line x1={PL} x2={W - PR} y1={py(v)} y2={py(v)}
              stroke={velColor(v)} strokeWidth={0.9} strokeDasharray="4 3" opacity={0.7} />
            <text x={W - PR + 4} y={py(v) + 3} fontSize={7}
              fill={velColor(v)} fontWeight="bold">{label}</text>
          </g>
        ))}

        {means.map((m, i) => {
          const x   = PL + i * slot + (slot - bw) / 2
          const yM  = py(m)
          const yU  = py(m + stds[i])
          const yL  = py(Math.max(0, m - stds[i]))
          const bH  = H - 4 - (H - 14) * 0 - yM   // bar from bottom to mean
          return (
            <g key={i}>
              <rect x={x} y={yM} width={bw} height={H - 4 - yM}
                fill={velColor(m)} opacity={0.85} rx={2} />
              {/* Std dev bar */}
              <line x1={x + bw / 2} x2={x + bw / 2} y1={yU} y2={yL}
                stroke="#1E293B" strokeWidth={1.2} opacity={0.4} />
              <line x1={x + bw / 4} x2={x + bw * 3 / 4} y1={yU} y2={yU}
                stroke="#1E293B" strokeWidth={1} opacity={0.4} />
              <line x1={x + bw / 4} x2={x + bw * 3 / 4} y1={yL} y2={yL}
                stroke="#1E293B" strokeWidth={1} opacity={0.4} />
              {/* Value label */}
              <text x={x + bw / 2} y={yM - 2} textAnchor="middle"
                fontSize={6} fill="#475569">{m.toFixed(0)}</text>
            </g>
          )
        })}

        {/* Y axis labels */}
        {[0, 32, 64, 96].map(v => (
          <text key={v} x={PL - 3} y={py(v) + 3} textAnchor="end"
            fontSize={7} fill="#94A3B8">{v}</text>
        ))}
      </svg>
      <XLabels labels={d.var_labels!} W={W} padL={PL} padR={PR} />
      <div style={{ display: 'flex', gap: 0, marginTop: 4, flexWrap: 'wrap' }}>
        <LegendDot color="#93C5FD" label={t(lang, 'pp 很弱 < 50',  'pp < 50')} />
        <LegendDot color="#6EE7B7" label={t(lang, 'p 弱 50–64',    'p 50–64')} />
        <LegendDot color="#FBBF24" label={t(lang, 'mp 中弱 65–79', 'mp 65–79')} />
        <LegendDot color="#FB923C" label={t(lang, 'mf 中强 80–94', 'mf 80–94')} />
        <LegendDot color="#F87171" label={t(lang, 'f 强 ≥ 95',     'f ≥ 95')} />
      </div>
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// Main component
// ════════════════════════════════════════════════════════════════════
export default function MIDIAnalysisPage({ data, lang }: Props) {
  const [analysis, setAnalysis] = useState<MidiAnalysisData | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  const fileName = data.metadata.file_name

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchMidiAnalysis(fileName)
      .then(d  => { setAnalysis(d); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [fileName])

  // ── States ──
  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>♩</div>
      <div style={{ fontSize: 13 }}>{t(lang, '正在加载 MIDI 分析…', 'Loading MIDI analysis…')}</div>
    </div>
  )

  if (error) return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: '#EF4444', marginBottom: 4 }}>{t(lang, '加载失败', 'Failed to load')}</div>
      <div style={{ fontSize: 11, color: '#94A3B8' }}>{error}</div>
    </div>
  )

  if (!analysis?.matched) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
      <div style={{ fontSize: 22, marginBottom: 8 }}>♪</div>
      <div style={{ fontSize: 13, color: '#475569' }}>{t(lang, '未找到匹配的 MIDI 文件', 'No matching MIDI file found')}</div>
      <div style={{ fontSize: 11, marginTop: 6 }}>
        {fileName} — {t(lang, '在 TV_MIDI/ 中无 K 编号匹配项', 'no K-catalogue match in TV_MIDI/')}
      </div>
    </div>
  )

  const d = analysis

  const intervalLayers: StackLayer[] = [
    { values: d.stp_r!,                                                  color: '#3B82F6', label: t(lang, '级进 ≤2 半音', 'Step ≤2 st') },
    { values: d.stp_r!.map((s,i) => Math.max(0,1-s-(d.lp_r![i]||0))), color: '#94A3B8', label: t(lang, '小跳 3–4 半音', 'Skip 3–4 st') },
    { values: d.lp_r!,                                                   color: '#EF4444', label: t(lang, '大跳 >4 半音', 'Leap >4 st') },
  ]

  const harmLayers: StackLayer[] = [
    { values: d.harm_t!, color: '#6366F1', label: t(lang, '主和弦 (I)', 'Tonic (I)') },
    { values: d.harm_d!, color: '#F97316', label: t(lang, '属和弦 (V)', 'Dominant (V)') },
    { values: d.harm_s!, color: '#10B981', label: t(lang, '下属和弦 (IV)', 'Subdominant (IV)') },
  ]

  const rhyLayers: StackLayer[] = [
    { values: d.rhy_quarter!, color: '#60A5FA', label: t(lang, '四分音符+', 'Quarter+') },
    { values: d.rhy_8th!,     color: '#34D399', label: t(lang, '八分音符', '8th') },
    { values: d.rhy_16th!,    color: '#FBBF24', label: t(lang, '十六分音符', '16th') },
    { values: d.rhy_32nd!,    color: '#F87171', label: t(lang, '三十二分音符+', '32nd+') },
  ]

  return (
    <div style={{ maxWidth: CHART_W + 32, margin: '0 auto' }}>

      {/* File badge */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <span style={{
          fontSize: 10, color: '#64748B', background: '#F1F5F9',
          padding: '3px 8px', borderRadius: 5,
          maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {d.midi_file}
        </span>
        <span style={{ fontSize: 10, color: '#94A3B8' }}>
          {d.total_bars} {t(lang, '小节', 'bars')} · {d.beats_per_bar}/4
          {' '}·{' '}
          <span style={{
            background: d.seg_method === 'annotation' ? '#DCFCE7' : '#FEF9C3',
            color:      d.seg_method === 'annotation' ? '#166534' : '#713F12',
            padding: '1px 5px', borderRadius: 3, fontWeight: 600,
          }}>
            {d.seg_method === 'annotation'
              ? t(lang, '标注分段', 'annotation')
              : t(lang, '固定分段', 'fixed')}
          </span>
        </span>
      </div>

      {/* ① Structure */}
      <Panel accent="#6366F1" title={t(lang,
        '① 结构骨架',
        '① Structural Skeleton')}>
        <StructureChart d={d} />
        <Insight lines={insightStructure(d, lang)} />
      </Panel>

      {/* ② Melody */}
      <Panel accent="#3B82F6" title={t(lang,
        '② 旋律走向  —  各变奏顶声部平均音高  |  误差线 = 第 10–90 百分位音域范围',
        '② Melodic Contour  —  Mean top-voice pitch per variation  |  error bars = 10th–90th percentile range')}>
        <MelodyChart d={d} />
        <Insight lines={insightMelody(d, lang)} />
      </Panel>

      {/* ③ Intervals */}
      <Panel accent="#EF4444" title={t(lang,
        '③ 音程运动  —  级进（≤2 半音）· 小跳（3–4）· 大跳（>4）',
        '③ Melodic Interval Motion  —  Step (≤2 st) · Skip (3–4) · Leap (>4)')}>
        <div style={{ display: 'flex', gap: 0, marginBottom: 8, flexWrap: 'wrap' }}>
          {intervalLayers.map(l => <LegendDot key={l.label} color={l.color} label={l.label} />)}
        </div>
        <StackedBarChart layers={intervalLayers} labels={d.var_labels!} H={100} />
        <Insight lines={insightIntervals(d, lang)} />
      </Panel>

      {/* ④ Harmony */}
      <Panel accent="#F97316" title={t(lang,
        '④ 和声指纹  —  各变奏音级分布星形图 · 调主与调式检测',
        '④ Harmonic Fingerprint  —  Pitch-class radar per variation · key & mode detection')}>
        {d.chroma
          ? <ChromaChart d={d} lang={lang} />
          : (
            <>
              <div style={{ display: 'flex', gap: 0, marginBottom: 8, flexWrap: 'wrap' }}>
                {harmLayers.map(l => <LegendDot key={l.label} color={l.color} label={l.label} />)}
              </div>
              <StackedBarChart layers={harmLayers} labels={d.var_labels!} H={100} />
            </>
          )}
        <Insight lines={insightHarmony(d, lang)} />
      </Panel>

      {/* ⑤ Rhythm */}
      <Panel accent="#FBBF24" title={t(lang,
        '⑤ 节奏比例  —  各变奏音符时值分布',
        '⑤ Rhythmic Ratios  —  Note value distribution per variation')}>
        <div style={{ display: 'flex', gap: 0, marginBottom: 8, flexWrap: 'wrap' }}>
          {rhyLayers.map(l => <LegendDot key={l.label} color={l.color} label={l.label} />)}
        </div>
        <StackedBarChart layers={rhyLayers} labels={d.var_labels!} H={100} />
        <Insight lines={insightRhythm(d, lang)} />
      </Panel>

      {/* ⑥ Dynamics */}
      <Panel accent="#10B981" title={t(lang,
        '⑥ 力度指令  —  各变奏平均 MIDI 力度值  |  误差线 = ±1 标准差',
        '⑥ Symbolic Dynamics  —  Mean MIDI velocity per variation  |  error bars = ±1 std dev')}>
        <DynamicsChart d={d} lang={lang} />
        <Insight lines={insightDynamics(d, lang)} />
      </Panel>

    </div>
  )
}
