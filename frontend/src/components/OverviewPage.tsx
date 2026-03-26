/**
 * OverviewPage — 综合视图（卡片网格）
 *
 * Same card style as ComparisonGrid / VariationCard.
 * Each card shows a concentric ring chart:
 *   ① Centre    — Timbre PCA scatter + 5 biplot arrows
 *   ② Ring 2    — Polar melody contour (angle=time, radius∝pitch)
 *   ③ Ring 3    — Chroma ring; only top-N pitch classes (chord tones) are coloured
 *   ④ Outer     — Rhythm bubbles (size=loudness, opacity=onset density)
 *
 * Click any card to open an enlarged modal with full labels.
 */

import { useMemo, useState, useCallback } from 'react'
import type { PieceData } from '../types/features'
import type { ThemeTokens } from '../theme'
import type { Lang } from '../App'
import {
  getContourData,
  globalContourRange,
  normaliseContour,
} from '../utils/pitchContour'
import { labelColor } from './PitchContour'

// ── PCA math ──────────────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number { return a.reduce((s, v, i) => s + v * b[i], 0) }
function matvec(M: number[][], v: number[]): number[] { return M.map(row => dot(row, v)) }
function normalize(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v)); return n < 1e-12 ? v.map(() => 0) : v.map(x => x / n)
}
function dominantEigenvector(M: number[][], iters = 150): number[] {
  let v = M.map((_, i) => i === 0 ? 1.0 : 0.1 * (i + 1)); v = normalize(v)
  for (let k = 0; k < iters; k++) v = normalize(matvec(M, v)); return v
}

interface PCAData {
  scores:   [number, number][]
  loadings: [number, number][]
  varRatio: [number, number]
}

function computePCA(mat: number[][]): PCAData | null {
  const N = mat.length, D = mat[0]?.length ?? 0
  if (N < 3 || D < 2) return null
  const means = Array.from({ length: D }, (_, j) => mat.reduce((s, r) => s + r[j], 0) / N)
  const stds  = Array.from({ length: D }, (_, j) => {
    const m = means[j]; return Math.sqrt(mat.reduce((s, r) => s + (r[j] - m) ** 2, 0) / (N - 1))
  })
  const X  = mat.map(r => r.map((v, j) => stds[j] > 1e-10 ? (v - means[j]) / stds[j] : 0))
  const C: number[][] = Array.from({ length: D }, (_, i) =>
    Array.from({ length: D }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) / (N - 1)))
  const pc1  = dominantEigenvector(C)
  const lam1 = dot(matvec(C, pc1), pc1)
  const C2   = C.map((row, i) => row.map((v, j) => v - lam1 * pc1[i] * pc1[j]))
  const pc2  = dominantEigenvector(C2)
  const lam2 = dot(matvec(C2, pc2), pc2)
  return {
    scores:   X.map(r => [dot(r, pc1), dot(r, pc2)]),
    loadings: Array.from({ length: D }, (_, j) => [pc1[j], pc2[j]]),
    varRatio: [lam1 / D, lam2 / D],
  }
}

// ── Chroma helpers ────────────────────────────────────────────────────────────

const COF_TO_CHROMA = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]
const PC_COLORS = [
  '#FF6B6B','#FF9A3C','#F4C430','#9ACD32','#2DC653','#06D6A0',
  '#4CC9F0','#4361EE','#7209B7','#B5179E','#F72585','#E63946',
]
const COF_COLORS = COF_TO_CHROMA.map(c => PC_COLORS[c])
const COF_NAMES  = ['C','G','D','A','E','B','F♯','D♭','A♭','E♭','B♭','F']

/** Returns 12 sector colours: top-N are their COF hue, rest are grey */
function chordColors(chroma: number[], topN: number, isDark: boolean): string[] {
  const grey = isDark ? '#555' : '#bbb'
  const ranked = chroma.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)
  const topSet = new Set(ranked.slice(0, topN).map(x => x.i))
  return chroma.map((_, i) => topSet.has(i) ? COF_COLORS[i] : grey)
}

function arcPath(cx:number,cy:number,ir:number,or_:number,a0:number,a1:number): string {
  const f=(n:number)=>n.toFixed(2)
  const s0=Math.sin(a0),c0=Math.cos(a0),s1=Math.sin(a1),c1=Math.cos(a1)
  const lg=a1-a0>Math.PI?1:0
  return [`M${f(cx+ir*s0)},${f(cy-ir*c0)}`,`A${ir},${ir},0,${lg},1,${f(cx+ir*s1)},${f(cy-ir*c1)}`,
    `L${f(cx+or_*s1)},${f(cy-or_*c1)}`,`A${or_},${or_},0,${lg},0,${f(cx+or_*s0)},${f(cy-or_*c0)}`,'Z'].join(' ')
}

// ── Polar melody helpers ──────────────────────────────────────────────────────

function polarFill(nv: number[], cx:number,cy:number,ir:number,mh:number): string {
  const n=nv.length; if(n<2) return ''
  const f=(v:number)=>v.toFixed(1)
  const outer=nv.map((ny,i)=>{const a=(i/(n-1))*2*Math.PI-Math.PI/2,r=ir+(1-ny)*mh;return[cx+r*Math.cos(a),cy+r*Math.sin(a)]})
  const inner=nv.map((_,i)=>{const a=(i/(n-1))*2*Math.PI-Math.PI/2;return[cx+ir*Math.cos(a),cy+ir*Math.sin(a)]})
  return [`M${f(outer[0][0])},${f(outer[0][1])}`,
    ...outer.slice(1).map(p=>`L${f(p[0])},${f(p[1])}`),
    `L${f(inner[n-1][0])},${f(inner[n-1][1])}`,
    ...inner.slice(0,n-1).reverse().map(p=>`L${f(p[0])},${f(p[1])}`),
    'Z'].join(' ')
}

function polarStroke(nv: number[], cx:number,cy:number,ir:number,mh:number): string {
  const n=nv.length; if(n<2) return ''
  const f=(v:number)=>v.toFixed(1)
  return nv.map((ny,i)=>{
    const a=(i/(n-1))*2*Math.PI-Math.PI/2,r=ir+(1-ny)*mh
    return (i===0?'M':'L')+f(cx+r*Math.cos(a))+','+f(cy+r*Math.sin(a))
  }).join(' ')+'Z'
}

// ── Arrow helper ──────────────────────────────────────────────────────────────

function arrowHead(x1:number,y1:number,x2:number,y2:number,hl:number,hw:number): string {
  const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy)||1
  const ux=dx/len,uy=dy/len,px=-uy,py=ux,f=(n:number)=>n.toFixed(1)
  return `${f(x2)},${f(y2)} ${f(x2-ux*hl+px*hw)},${f(y2-uy*hl+py*hw)} ${f(x2-ux*hl-px*hw)},${f(y2-uy*hl-py*hw)}`
}

const FEATURE_ZH   = ['亮度','响度','粗糙','调性','和声']
const FEATURE_EN   = ['Bright','Loud','Rough','Tonal','Harm']
const ARROW_COLORS = ['#E76F51','#2A9D8F','#E9C46A','#A8DADC','#B79CED']

// ── Rhythm helpers ────────────────────────────────────────────────────────────

const N_BUBBLES = 32

function buildBubbles(
  rms64: number[], onsetCount: number[]|undefined,
  globalMaxRms: number, onsetDensity: number, windowDurSec: number,
): { r: number; opacity: number; od: number; meanRms: number }[] {
  const hasOC=(onsetCount?.length??0)>0
  return Array.from({length:N_BUBBLES},(_,b)=>{
    const start=b*2,end=start+2
    const slice=rms64.slice(start,end)
    const mean=slice.reduce((a,v)=>a+v,0)/(slice.length||1)
    const r=Math.sqrt(globalMaxRms>0?mean/globalMaxRms:0)
    let opacity:number, od:number
    if(hasOC&&onsetCount){
      const oc=onsetCount.slice(start,end).reduce((a:number,v:number)=>a+v,0)
      od=windowDurSec>0?oc/windowDurSec:0
      opacity=Math.min(0.92,Math.max(0.04,od/10))
    } else {
      od=onsetDensity
      opacity=Math.min(0.9,Math.max(0.12,onsetDensity/10))
    }
    return {r,opacity,od,meanRms:mean}  // r is [0,1]; scaled by MAX_BUB_R in chart
  })
}

// ── Ring geometry ─────────────────────────────────────────────────────────────

function geo(size: number) {
  const s=size/180
  return {
    CX:size/2, CY:size/2,
    PCA_R:      28*s,
    MEL_INNER:  31*s, MEL_MAX_H:  11*s,
    CHR_INNER:  45*s, CHR_MAX_ADD:11*s,
    BUB_R:      68*s, MAX_BUB_R:   9*s,
  }
}

// ── Ring chart SVG ────────────────────────────────────────────────────────────

// Pitch reference points (semitones from tonic) to draw in the polar melody band
// RELATIVE_MIN=-5, RELATIVE_SPAN=29 → normY = 1-(semitone+5)/29
const PITCH_REFS: { semitone: number; label: string }[] = [
  { semitone: 0,  label: '0'   },   // tonic
  { semitone: 12, label: '+12' },   // octave
]

// ── Chord arc helpers ─────────────────────────────────────────────────────────

// COF_TO_CHROMA[cofPos] = chromatic_idx.  This permutation is its own inverse:
// CHROMA_TO_COF[chromatic_idx] = cofPos — same array.
const CHROMA_TO_COF = COF_TO_CHROMA  // [0,7,2,9,4,11,6,1,8,3,10,5]

/** Build a 12×12 root-level directed transition matrix from the 24×24 full matrix */
function rootTransitions(trans24: number[][]): number[][] {
  const rt = Array.from({length:12}, ()=>Array(12).fill(0))
  for (let i=0;i<24;i++) for (let j=0;j<24;j++) {
    if (trans24[i][j]>0) rt[i%12][j%12] += trans24[i][j]
  }
  return rt
}

/** Top-N directed arcs (i→j, count) from a 12×12 matrix, excluding self-loops */
function topArcs(rt: number[][], n: number): {i:number,j:number,count:number}[] {
  const arcs: {i:number,j:number,count:number}[] = []
  for (let i=0;i<12;i++) for (let j=0;j<12;j++) {
    if (i!==j && rt[i][j]>0) arcs.push({i,j,count:rt[i][j]})
  }
  arcs.sort((a,b)=>b.count-a.count)
  return arcs.slice(0, n)
}

interface ChordRecData { chord_sequence: number[]; transition_matrix: number[][] }

interface RingProps {
  normContour:  number[]
  pcaData:      PCAData | null
  activeIdx:    number
  segments:     PieceData['segments']
  chroma:       number[]
  bubbles:      { r: number; opacity: number; od: number; meanRms: number }[]
  avgDensity:   number            // segment-level avg onset density (for density label)
  avgRms:       number            // mean RMS of segment rms64 (for bubble finding + label)
  pieceAvgRms:  number            // piece-wide mean RMS (denominator for loudness %)
  segColor:     string
  sectorColors: string[]          // per-sector color (chord-filtered)
  isDark:       boolean
  size:         number
  showLabels?:  boolean
  lang?:        Lang
  chordRec?:    ChordRecData      // chord recognition data (optional)
  chordMode?:   boolean           // if true, overlay chord transition arcs
}

function RingChart({ normContour,pcaData,activeIdx,segments,chroma,bubbles,
  avgDensity,avgRms,pieceAvgRms,segColor,sectorColors,isDark,size,showLabels,lang,
  chordRec,chordMode }: RingProps) {
  const g   = geo(size)
  const gc  = isDark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.07)'
  const sep = isDark?'rgba(255,255,255,0.13)':'rgba(0,0,0,0.10)'
  const zh  = lang==='zh'
  const f   = (n:number)=>n.toFixed(1)

  // PCA scatter
  const pcaDots = useMemo(()=>{
    if(!pcaData) return []
    const {scores}=pcaData
    const xs=scores.map(s=>s[0]),ys=scores.map(s=>s[1])
    const xMid=(Math.min(...xs)+Math.max(...xs))/2, yMid=(Math.min(...ys)+Math.max(...ys))/2
    const rng=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))/2*1.35||1
    return scores.map((sc,i)=>({
      x:g.CX+((sc[0]-xMid)/rng)*g.PCA_R, y:g.CY-((sc[1]-yMid)/rng)*g.PCA_R,
      color:labelColor(segments[i].index), active:i===activeIdx, label:segments[i].label,
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pcaData,activeIdx,segments,g.CX,g.CY,g.PCA_R])

  // Biplot arrows
  const arrows = useMemo(()=>{
    if(!pcaData) return []
    const {scores,loadings}=pcaData
    const xs=scores.map(s=>s[0]),ys=scores.map(s=>s[1])
    const rng=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))/2*1.35||1
    const maxL=Math.max(...loadings.map(l=>Math.sqrt(l[0]**2+l[1]**2)),0.001)
    const scale=(g.PCA_R/rng)*rng*0.85/maxL
    return loadings.map((l,i)=>({
      tx:g.CX+l[0]*scale, ty:g.CY-l[1]*scale,
      color:ARROW_COLORS[i], label:zh?FEATURE_ZH[i]:FEATURE_EN[i],
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pcaData,g.CX,g.CY,g.PCA_R,zh])

  // Chroma sectors
  const total=chroma.reduce((a,v)=>a+v,0)||1
  const maxC=Math.max(...chroma,0.001)
  const sectors=chroma.map((v,i)=>{
    const norm=v/maxC, outerR=g.CHR_INNER+norm*g.CHR_MAX_ADD
    const sl=(2*Math.PI)/12, startA=i*sl-Math.PI/2, endA=startA+sl*0.86, midA=startA+sl*0.43
    const pct=Math.round(v/total*100)
    return {norm,outerR,d:arcPath(g.CX,g.CY,g.CHR_INNER,outerR,startA,endA),
      color:sectorColors[i],midA,pct,labelR:g.CHR_INNER+norm*g.CHR_MAX_ADD/2}
  })

  // Rhythm bubbles
  const bubPts=bubbles.map((b,i)=>{
    const a=(i/N_BUBBLES)*2*Math.PI-Math.PI/2
    return {cx:g.CX+g.BUB_R*Math.cos(a),cy:g.CY+g.BUB_R*Math.sin(a),
      r:b.r*g.MAX_BUB_R,opacity:b.opacity,od:b.od}
  })

  // Find bubble closest to the segment's average onset density → density label
  const closestBubIdx = bubbles.reduce((best,b,i)=>
    Math.abs(b.od-avgDensity)<Math.abs(bubbles[best].od-avgDensity)?i:best, 0)

  // Find bubble whose meanRms is closest to the segment avgRms → loudness label
  const closestLoudBubIdx = bubbles.reduce((best,b,i)=>
    Math.abs(b.meanRms-avgRms)<Math.abs(bubbles[best].meanRms-avgRms)?i:best, 0)

  // PC1/PC2 variance percentages for crosshair labels
  const varPct = pcaData ? pcaData.varRatio.map(v=>Math.round(v*100)) : [0,0]

  // Pitch reference radii within the polar melody band: r = MEL_INNER + (st+5)/29 * MEL_MAX_H
  const pitchRefRings = PITCH_REFS.map(pr=>({
    r: g.MEL_INNER + ((pr.semitone+5)/29)*g.MEL_MAX_H,
    label: pr.label,
  }))

  const hl=size<200?3:5, hw=size<200?2:3

  // Chord transition arcs (computed only when chordMode is active)
  const chordArcs = useMemo(()=>{
    if (!chordMode || !chordRec) return []
    const rt = rootTransitions(chordRec.transition_matrix)
    const arcs = topArcs(rt, 12)
    const maxCount = arcs[0]?.count ?? 1
    const r = g.CHR_INNER - 2  // just inside the chroma ring
    return arcs.map(({i,j,count})=>{
      const pi = CHROMA_TO_COF[i], pj = CHROMA_TO_COF[j]
      const ai = (pi/12)*2*Math.PI - Math.PI/2
      const aj = (pj/12)*2*Math.PI - Math.PI/2
      const x1 = g.CX + r*Math.cos(ai), y1 = g.CY + r*Math.sin(ai)
      const x2 = g.CX + r*Math.cos(aj), y2 = g.CY + r*Math.sin(aj)
      // Quadratic bezier: control point pulled ~70% toward center (creates inward curve)
      const cx = g.CX + (x1+x2-2*g.CX)*0.15
      const cy = g.CY + (y1+y2-2*g.CY)*0.15
      // Arrowhead tangent at end = direction from control → endpoint
      const tx=x2-cx, ty=y2-cy, tlen=Math.sqrt(tx*tx+ty*ty)||1
      const ux=tx/tlen, uy=ty/tlen
      const ahLen=size<200?3.5:5.5, ahW=size<200?1.5:2.5
      const px=-uy, py=ux  // perpendicular
      const tip = `${f(x2)},${f(y2)}`
      const bl  = `${f(x2-ux*ahLen+px*ahW)},${f(y2-uy*ahLen+py*ahW)}`
      const br  = `${f(x2-ux*ahLen-px*ahW)},${f(y2-uy*ahLen-py*ahW)}`
      const norm = count/maxCount
      return { d:`M${f(x1)},${f(y1)} Q${f(cx)},${f(cy)} ${f(x2)},${f(y2)}`,
        arrow:`${tip} ${bl} ${br}`, opacity:0.25+0.65*norm,
        strokeW: size<200 ? 0.6+1.8*norm : 0.8+2.8*norm }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chordMode, chordRec, g.CX, g.CY, g.CHR_INNER, size])

  return (
    <svg width={size} height={size} style={{display:'block',flexShrink:0}}>
      {/* background */}
      <circle cx={g.CX} cy={g.CY} r={size/2-2}
        fill={isDark?'rgba(255,255,255,0.025)':'rgba(0,0,0,0.025)'} stroke={sep} strokeWidth={0.8}/>

      {/* ① PCA area */}
      <circle cx={g.CX} cy={g.CY} r={g.PCA_R}
        fill={isDark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.04)'}/>
      <line x1={f(g.CX-g.PCA_R)} y1={f(g.CY)} x2={f(g.CX+g.PCA_R)} y2={f(g.CY)} stroke={gc} strokeWidth={0.7}/>
      <line x1={f(g.CX)} y1={f(g.CY-g.PCA_R)} x2={f(g.CX)} y2={f(g.CY+g.PCA_R)} stroke={gc} strokeWidth={0.7}/>
      {/* PC1/PC2 variance % labels at crosshair ends */}
      {pcaData&&(()=>{
        const fs=size<200?4:6
        const txtFill=isDark?'rgba(255,255,255,0.55)':'rgba(0,0,0,0.50)'
        return <>
          <text x={f(g.CX+g.PCA_R)} y={f(g.CY-2)} fontSize={fs}
            textAnchor="end" fill={txtFill} style={{userSelect:'none'}}>
            PC1 {varPct[0]}%
          </text>
          <text x={f(g.CX+2)} y={f(g.CY-g.PCA_R+fs)} fontSize={fs}
            textAnchor="start" fill={txtFill} style={{userSelect:'none'}}>
            PC2 {varPct[1]}%
          </text>
        </>
      })()}

      {arrows.map((a,i)=>(
        <g key={`ar${i}`}>
          <line x1={f(g.CX)} y1={f(g.CY)} x2={f(a.tx)} y2={f(a.ty)}
            stroke={a.color} strokeWidth={size<200?1:1.4} opacity={0.75}/>
          <polygon points={arrowHead(g.CX,g.CY,a.tx,a.ty,hl,hw)} fill={a.color} opacity={0.85}/>
        </g>
      ))}

      {pcaDots.filter(d=>!d.active).map((d,i)=>(
        <circle key={i} cx={f(d.x)} cy={f(d.y)} r={size<200?2:3.5} fill={d.color} opacity={0.3}/>
      ))}
      {pcaDots.find(d=>d.active)&&(()=>{
        const d=pcaDots.find(d=>d.active)!,r=size<200?4.5:6.5
        return <>
          <circle cx={f(d.x)} cy={f(d.y)} r={r+3} fill={d.color} opacity={0.1}/>
          <circle cx={f(d.x)} cy={f(d.y)} r={r} fill={d.color} opacity={0.95}
            stroke={isDark?'rgba(255,255,255,0.45)':'rgba(255,255,255,0.85)'} strokeWidth={1.2}/>
          {showLabels&&<text x={f(d.x+r+4)} y={f(d.y+3)} fontSize={8} fontWeight="700" fill={d.color}>{d.label}</text>}
        </>
      })()}

      {/* separator 1 */}
      <circle cx={g.CX} cy={g.CY} r={g.MEL_INNER-1} fill="none" stroke={sep} strokeWidth={0.8}/>

      {/* ② polar melody */}
      <path d={polarFill(normContour,g.CX,g.CY,g.MEL_INNER,g.MEL_MAX_H)} fill={segColor} opacity={0.18}/>
      <path d={polarStroke(normContour,g.CX,g.CY,g.MEL_INNER,g.MEL_MAX_H)}
        fill="none" stroke={segColor} strokeWidth={size<200?1:1.5} opacity={0.75} strokeLinejoin="round"/>
      {/* Pitch reference circles (tonic=0, octave=+12) */}
      {pitchRefRings.map((pr,i)=>(
        <g key={`pref${i}`}>
          <circle cx={f(g.CX)} cy={f(g.CY)} r={f(pr.r)}
            fill="none" stroke={segColor}
            strokeWidth={0.6} strokeDasharray="2,3" opacity={0.45}/>
          {/* label at 3 o'clock — always show, tiny in compact */}
          <text
            x={f(g.CX+pr.r+1)} y={f(g.CY+1)}
            fontSize={size<200?4.5:6.5}
            dominantBaseline="middle"
            fill={segColor} opacity={size<200?0.55:0.75}
            style={{userSelect:'none'}}>
            {pr.label}
          </text>
        </g>
      ))}

      {/* separator 2 */}
      <circle cx={g.CX} cy={g.CY} r={g.CHR_INNER-1} fill="none" stroke={sep} strokeWidth={0.8}/>

      {/* ③ chroma ring */}
      {sectors.map((s,i)=>(
        <g key={`ch${i}`}>
          <path d={s.d} fill={s.color}
            opacity={(chordMode
              ? 0.12   // dimmed in chord mode
              : (s.color===sectorColors[i]&&s.color!=='#555'&&s.color!=='#bbb'
                ? 0.55+s.norm*0.4
                : 0.25))}
            stroke={isDark?'#0F172A':'#FFFFFF'} strokeWidth={0.5}/>
          {/* percentage — show for coloured chord tones */}
          {s.pct>=(showLabels?4:10)&&s.color!=='#555'&&s.color!=='#bbb'&&(()=>{
            const tx=g.CX+s.labelR*Math.sin(s.midA), ty=g.CY-s.labelR*Math.cos(s.midA)
            return <text x={f(tx)} y={f(ty+2)} fontSize={size<200?5.5:7}
              textAnchor="middle" dominantBaseline="middle"
              fill={isDark?'rgba(255,255,255,0.9)':'rgba(0,0,0,0.8)'} fontWeight="700">
              {s.pct}%
            </text>
          })()}
          {/* note names (modal only) */}
          {showLabels&&s.norm>0.2&&(()=>{
            const lr=s.outerR+10
            const tx=g.CX+lr*Math.sin(s.midA), ty=g.CY-lr*Math.cos(s.midA)
            return <text x={f(tx)} y={f(ty+2)} fontSize={7} textAnchor="middle" dominantBaseline="middle"
              fill={s.color==='#555'||s.color==='#bbb'
                ? (isDark?'rgba(255,255,255,0.3)':'rgba(0,0,0,0.25)')
                : (isDark?'rgba(255,255,255,0.7)':'rgba(0,0,0,0.6)')}>
              {COF_NAMES[i]}
            </text>
          })()}
        </g>
      ))}

      {/* separator 3 */}
      <circle cx={g.CX} cy={g.CY} r={g.BUB_R-g.MAX_BUB_R-1} fill="none" stroke={sep} strokeWidth={0.8}/>

      {/* ③-b chord transition arcs (chord mode only) */}
      {chordMode && chordArcs.map((a,i)=>(
        <g key={`ca${i}`}>
          <path d={a.d} fill="none" stroke={segColor}
            strokeWidth={a.strokeW} opacity={a.opacity} strokeLinecap="round"/>
          <polygon points={a.arrow} fill={segColor} opacity={a.opacity+0.1}/>
        </g>
      ))}

      {/* ④ rhythm bubbles */}
      {bubPts.map((b,i)=>(
        <circle key={`bub${i}`} cx={f(b.cx)} cy={f(b.cy)}
          r={b.r.toFixed(2)} fill={segColor} opacity={b.opacity}/>
      ))}
      {/* Average density label inside the closest-density bubble */}
      {(()=>{
        const b=bubPts[closestBubIdx]
        const fs=size<200?4.5:7
        const fill=isDark?'#fff':'#000'
        const op=size<200?0.75:0.9
        if(size<200){
          return (
            <text key="densLabel" x={f(b.cx)} y={f(b.cy+fs*0.35)}
              fontSize={fs} textAnchor="middle"
              fill={fill} opacity={op} fontWeight="600" style={{userSelect:'none'}}>
              {avgDensity.toFixed(1)}/s
            </text>
          )
        }
        return (
          <text key="densLabel" x={f(b.cx)} y={f(b.cy-fs*0.6)}
            fontSize={fs} textAnchor="middle"
            fill={fill} opacity={op} fontWeight="600" style={{userSelect:'none'}}>
            <tspan x={f(b.cx)} dy="0">{zh?'起音密度':'density'}</tspan>
            <tspan x={f(b.cx)} dy={fs*1.15}>{avgDensity.toFixed(1)}/s</tspan>
          </text>
        )
      })()}
      {/* Average loudness label inside the closest-RMS bubble (% relative to piece avg) */}
      {(()=>{
        const b=bubPts[closestLoudBubIdx]
        const fs=size<200?4.5:7
        const pct=Math.round(avgRms/(pieceAvgRms||1)*100)
        const fill=isDark?'#fff':'#000'
        const op=size<200?0.75:0.9
        if(size<200){
          return (
            <text key="loudLabel" x={f(b.cx)} y={f(b.cy+fs*0.35)}
              fontSize={fs} textAnchor="middle"
              fill={fill} opacity={op} fontWeight="600" style={{userSelect:'none'}}>
              {pct}%
            </text>
          )
        }
        return (
          <text key="loudLabel" x={f(b.cx)} y={f(b.cy-fs*0.6)}
            fontSize={fs} textAnchor="middle"
            fill={fill} opacity={op} fontWeight="600" style={{userSelect:'none'}}>
            <tspan x={f(b.cx)} dy="0">{pct}%</tspan>
            <tspan x={f(b.cx)} dy={fs*1.15}>{zh?'段落响度':'loudness'}</tspan>
          </text>
        )
      })()}
    </svg>
  )
}

// ── Overview card (matches VariationCard style) ───────────────────────────────

interface CardProps {
  segment:      PieceData['segments'][number]
  normContour:  number[]
  pcaData:      PCAData | null
  allSegments:  PieceData['segments']
  globalMaxRms: number
  pieceAvgRms:  number
  topN:         number
  isDark:       boolean
  theme:        ThemeTokens
  lang:         Lang
  onClick:      () => void
}

const CARD_W    = 164
const RING_SIZE = 140   // fits inside card with 12px total horizontal padding

function OverviewCard({ segment,normContour,pcaData,allSegments,globalMaxRms,pieceAvgRms,topN,isDark,theme,lang,onClick }: CardProps) {
  const accent    = labelColor(segment.index)
  const chroma    = segment.features.chroma_cof ?? []
  const sColors   = chordColors(chroma, topN, isDark)
  const compressed  = segment.features.compressed
  const rms64       = compressed?.rms ?? []
  const onsetCount  = compressed?.onset_count
  const winDur      = segment.duration_sec>0 ? segment.duration_sec/N_BUBBLES : 1
  const bubbles = buildBubbles(rms64,onsetCount,globalMaxRms,segment.features.onset_density??0,winDur)
  const avgRms  = rms64.length>0 ? rms64.reduce((a,v)=>a+v,0)/rms64.length : 0
  const chordRec = segment.features.chord_recognition

  const [chordMode, setChordMode] = useState(false)
  const zh = lang==='zh'

  const mins=Math.floor(segment.duration_sec/60)
  const secs=Math.round(segment.duration_sec%60)
  const durStr=mins>0?`${mins}:${secs.toString().padStart(2,'0')}`:`${secs}s`

  const segIdx = allSegments.indexOf(segment)

  return (
    <div
      onClick={onClick}
      style={{
        display:'flex', flexDirection:'column', alignItems:'center', gap:5,
        padding:'10px 8px 8px', borderRadius:10, cursor:'pointer',
        background: theme.cardBg,
        border: theme.cardBorder,
        boxShadow: theme.cardShadow,
        transition:'transform 0.15s, box-shadow 0.15s, border 0.15s',
        minWidth:CARD_W, maxWidth:CARD_W, userSelect:'none',
      }}
      onMouseEnter={e=>{
        const el=e.currentTarget as HTMLElement
        el.style.transform='translateY(-3px)'
        el.style.boxShadow=`0 6px 20px ${accent}33`
        el.style.border=`1px solid ${accent}88`
      }}
      onMouseLeave={e=>{
        const el=e.currentTarget as HTMLElement
        el.style.transform='none'
        el.style.boxShadow=theme.cardShadow??''
        el.style.border=theme.cardBorder??''
      }}
    >
      {/* Label */}
      <span style={{ fontSize:theme.fontSizeLabel, fontWeight:700,
        fontFamily:theme.fontFamily, color:accent, letterSpacing:'0.04em' }}>
        {segment.label}
      </span>

      {/* Ring chart */}
      <RingChart
        normContour={normContour}
        pcaData={pcaData}
        activeIdx={segIdx}
        segments={allSegments}
        chroma={chroma}
        bubbles={bubbles}
        avgDensity={segment.features.onset_density ?? 0}
        avgRms={avgRms}
        pieceAvgRms={pieceAvgRms}
        segColor={accent}
        sectorColors={sColors}
        isDark={isDark}
        size={RING_SIZE}
        lang={lang}
        chordRec={chordRec}
        chordMode={chordMode}
      />

      {/* Meta row + chord toggle */}
      <div style={{
        display:'flex', alignItems:'center', gap:5,
        fontSize:theme.fontSizeMeta, fontFamily:theme.fontFamily,
        color:theme.labelSecondaryColor, width:'100%',
      }}>
        <span>{durStr}</span>
        <span>·</span>
        <span>{(segment.features.onset_density??0).toFixed(1)}/s</span>
        {chordRec && (
          <button
            onClick={e=>{ e.stopPropagation(); setChordMode(m=>!m) }}
            title={zh ? (chordMode?'切回色度能量':'显示和弦走向') : (chordMode?'Show energy':'Show chords')}
            style={{
              marginLeft:'auto', fontSize:8, padding:'1px 5px', borderRadius:4, cursor:'pointer',
              background: chordMode ? accent : 'transparent',
              color: chordMode ? '#fff' : theme.labelSecondaryColor,
              border: `1px solid ${chordMode ? accent : (isDark?'rgba(255,255,255,0.2)':'rgba(0,0,0,0.15)')}`,
              fontFamily: theme.fontFamily, lineHeight:1.4,
              transition:'background 0.15s, color 0.15s',
            }}>
            {zh ? (chordMode?'色度':'和弦') : (chordMode?'Energy':'Chord')}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Modal (enlarged card) ─────────────────────────────────────────────────────

interface ModalProps {
  segIdx:       number
  segments:     PieceData['segments']
  contours:     number[][]
  globalMaxRms: number
  pieceAvgRms:  number
  pcaData:      PCAData | null
  topN:         number
  theme:        ThemeTokens
  isDark:       boolean
  lang:         Lang
  onClose:      () => void
}

function PanelModal({ segIdx,segments,contours,globalMaxRms,pieceAvgRms,pcaData,topN,theme,isDark,lang,onClose }: ModalProps) {
  const seg      = segments[segIdx]
  const segColor = labelColor(seg.index)
  const chroma   = seg.features.chroma_cof ?? []
  const sColors  = chordColors(chroma, topN, isDark)
  const zh       = lang==='zh'

  const compressed  = seg.features.compressed
  const rms64       = compressed?.rms ?? []
  const onsetCount  = compressed?.onset_count
  const winDur      = seg.duration_sec>0 ? seg.duration_sec/N_BUBBLES : 1
  const bubbles = buildBubbles(rms64,onsetCount,globalMaxRms,seg.features.onset_density??0,winDur)
  const avgRms  = rms64.length>0 ? rms64.reduce((a,v)=>a+v,0)/rms64.length : 0
  const varPct  = pcaData ? pcaData.varRatio.map(v=>Math.round(v*100)) : [0,0]
  const chordRec = seg.features.chord_recognition
  const [chordMode, setChordMode] = useState(false)

  return (
    <div onClick={onClose} style={{
      position:'fixed',inset:0,zIndex:999,
      background:'rgba(0,0,0,0.58)',
      display:'flex',alignItems:'center',justifyContent:'center',
      backdropFilter:'blur(3px)',
    }}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:theme.cardBg, borderRadius:14,
        boxShadow:'0 10px 52px rgba(0,0,0,0.55)',
        border:theme.cardBorder,
        padding:'16px 22px 20px',
        fontFamily:theme.fontFamily,
        display:'flex', flexDirection:'column', gap:14,
        maxWidth:'92vw',
      }}>
        {/* Header */}
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span style={{fontWeight:700,fontSize:14,color:segColor}}>{seg.label}</span>
          <span style={{fontSize:11,color:theme.labelSecondaryColor,flex:1}}>
            {zh?'综合视图':'Overview'}
          </span>
          {chordRec && (
            <button
              onClick={()=>setChordMode(m=>!m)}
              style={{
                fontSize:11, padding:'2px 10px', borderRadius:6, cursor:'pointer',
                background: chordMode ? segColor : 'transparent',
                color: chordMode ? '#fff' : theme.labelSecondaryColor,
                border: `1px solid ${chordMode ? segColor : (isDark?'rgba(255,255,255,0.2)':'rgba(0,0,0,0.15)')}`,
                fontFamily: theme.fontFamily, transition:'background 0.15s, color 0.15s',
              }}>
              {zh ? (chordMode?'色度':'和弦走向') : (chordMode?'Energy':'Chord paths')}
            </button>
          )}
          <button onClick={onClose} style={{
            background:'transparent',border:theme.cardBorder,borderRadius:6,
            padding:'2px 9px',cursor:'pointer',fontSize:13,color:theme.labelSecondaryColor,
          }}>✕</button>
        </div>

        <div style={{display:'flex',gap:22,alignItems:'flex-start',flexWrap:'wrap'}}>
          <RingChart
            normContour={contours[segIdx]} pcaData={pcaData}
            activeIdx={segIdx} segments={segments}
            chroma={chroma} bubbles={bubbles}
            avgDensity={seg.features.onset_density ?? 0}
            avgRms={avgRms}
            pieceAvgRms={pieceAvgRms}
            segColor={segColor} sectorColors={sColors}
            isDark={isDark} size={320} showLabels lang={lang}
            chordRec={chordRec} chordMode={chordMode}
          />

          {/* Legend */}
          <div style={{fontSize:10,color:theme.labelSecondaryColor,lineHeight:2.0,minWidth:155}}>
            <div style={{fontWeight:700,fontSize:11,color:theme.labelColor,marginBottom:6}}>
              {zh?'图层说明':'Layer guide'}
            </div>

            <div style={{marginBottom:8}}>
              <b style={{color:theme.labelColor}}>① {zh?'音色 PCA':'Timbre PCA'}</b>
              <div style={{paddingLeft:8,fontSize:9,opacity:0.75}}>
                {`PC1 ${varPct[0]}% + PC2 ${varPct[1]}%`}
              </div>
              <div style={{paddingLeft:8,marginTop:2}}>
                {ARROW_COLORS.map((c,i)=>(
                  <span key={i} style={{marginRight:6}}>
                    <span style={{color:c,fontWeight:700}}>→</span>{' '}
                    <span style={{fontSize:9}}>{zh?FEATURE_ZH[i]:FEATURE_EN[i]}</span>
                  </span>
                ))}
              </div>
            </div>

            <div style={{marginBottom:8}}>
              <b style={{color:theme.labelColor}}>② {zh?'极坐标旋律':'Polar melody'}</b>
              <div style={{paddingLeft:8,fontSize:9,opacity:0.75}}>
                {zh?'角度 = 时间，半径 = 音高':'Angle = time, radius = pitch'}
              </div>
            </div>

            <div style={{marginBottom:8}}>
              <b style={{color:theme.labelColor}}>③ {zh?'色度环':'Chroma ring'}</b>
              <div style={{paddingLeft:8,fontSize:9,opacity:0.75}}>
                {zh?`彩色 = 主要和弦音（前 ${topN} 个），灰色 = 非和弦音`
                   :`Colour = top ${topN} chord tones, grey = others`}
              </div>
              <div style={{paddingLeft:8,fontSize:9,opacity:0.75}}>
                {zh?'扇区高度 = 强度，数字 = 占比%':'Height = energy, number = %'}
              </div>
            </div>

            <div>
              <b style={{color:theme.labelColor}}>④ {zh?'节奏气泡':'Rhythm bubbles'}</b>
              <div style={{paddingLeft:8,fontSize:9,opacity:0.75}}>
                {zh?'气泡大小 = 该段平均响度，透明度 = 起音密度'
                   :'Size = avg loudness, opacity = onset density'}
              </div>
              <div style={{paddingLeft:8,marginTop:3,fontSize:9,lineHeight:1.7}}>
                <span style={{color:theme.labelColor,fontWeight:600}}>
                  {zh?'起音密度：':'Onset density: '}
                </span>
                {(seg.features.onset_density??0).toFixed(1)}/s
                {zh?' （每秒平均起音次数）':' (attacks per second)'}
              </div>
              <div style={{paddingLeft:8,fontSize:9,lineHeight:1.7}}>
                <span style={{color:theme.labelColor,fontWeight:600}}>
                  {zh?'段落响度：':'Segment loudness: '}
                </span>
                {Math.round(avgRms/(pieceAvgRms||1)*100)}%
                {zh?' （相对整首曲子的平均响度）':' (vs. piece average)'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface Props {
  data:   PieceData
  theme:  ThemeTokens
  isDark: boolean
  lang:   Lang
}

/** How many top pitch classes to colour as "chord tones" */
const CHORD_TOP_N = 3

export function OverviewPage({ data, theme, isDark, lang }: Props) {
  const { segments } = data
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const open  = useCallback((i: number) => setOpenIdx(i), [])
  const close = useCallback(() => setOpenIdx(null), [])

  const range    = useMemo(() => globalContourRange(segments), [segments])
  const contours = useMemo(() =>
    segments.map(seg => normaliseContour(getContourData(seg).values, range)),
  [segments, range])

  const globalMaxRms = useMemo(() => {
    let max=0
    segments.forEach(seg=>(seg.features.compressed?.rms??[]).forEach(v=>{if(v>max)max=v}))
    return max||1
  }, [segments])

  // Piece-wide average RMS (across all frames of all segments) — used as loudness baseline
  const pieceAvgRms = useMemo(() => {
    const all=segments.flatMap(seg=>seg.features.compressed?.rms??[])
    return all.length>0 ? all.reduce((a,v)=>a+v,0)/all.length : 1
  }, [segments])

  const pcaData = useMemo(() => {
    const matrix=segments.map(s=>{
      const f=s.features,cv=f.spectral_contrast_mean??[]
      const cm=cv.length>0?cv.reduce((a,v)=>a+v,0)/cv.length:0
      return [f.spectral_centroid_mean??0,f.rms_mean??0,f.zcr_mean??0,f.spectral_flatness_mean??0,cm]
    })
    return computePCA(matrix)
  }, [segments])

  const zh = lang==='zh'

  return (
    <div style={{padding:'8px 4px',fontFamily:theme.fontFamily}}>
      {/* Hint row */}
      <div style={{
        marginBottom:10,fontSize:9,color:theme.labelSecondaryColor,
        display:'flex',gap:14,flexWrap:'wrap',padding:'0 8px',
      }}>
        <span>① {zh?'音色 PCA + 箭头':'Timbre PCA + arrows'}</span>
        <span>② {zh?'旋律（极坐标）':'Melody (polar)'}</span>
        <span>③ {zh?`色度（彩色 = 前 ${CHORD_TOP_N} 和弦音）`:`Chroma (colour = top ${CHORD_TOP_N} chord tones)`}</span>
        <span>④ {zh?'节奏气泡':'Rhythm bubbles'}</span>
        <span style={{marginLeft:'auto'}}>{zh?'点击放大':'Click to enlarge'}</span>
      </div>

      {/* Card grid */}
      <div style={{
        display:'flex', flexDirection:'row', flexWrap:'wrap',
        gap:10, padding:'4px 8px 8px',
      }}>
        {segments.map((seg, idx) => (
          <OverviewCard
            key={seg.label}
            segment={seg}
            normContour={contours[idx]}
            pcaData={pcaData}
            allSegments={segments}
            globalMaxRms={globalMaxRms}
            pieceAvgRms={pieceAvgRms}
            topN={CHORD_TOP_N}
            isDark={isDark}
            theme={theme}
            lang={lang}
            onClick={() => open(idx)}
          />
        ))}
      </div>

      {openIdx !== null && (
        <PanelModal
          segIdx={openIdx} segments={segments} contours={contours}
          globalMaxRms={globalMaxRms} pieceAvgRms={pieceAvgRms} pcaData={pcaData} topN={CHORD_TOP_N}
          theme={theme} isDark={isDark} lang={lang}
          onClose={close}
        />
      )}
    </div>
  )
}
