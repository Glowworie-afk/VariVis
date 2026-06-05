import type { PieceMeta } from '@/api/pieceApi'
import type { PieceData } from '@/types/features'

/** Extract the performance version number from a file_name like "WAMozart_K265_3" → 3 */
export function perfVersion(fileName: string): number | null {
  const m = fileName.match(/_(\d+)$/)
  return m ? parseInt(m[1], 10) : null
}

export function shortName(meta: PieceMeta): string {
  const m = meta.music_name.match(/"(.+?)"/)
  const name = m ? m[1] : meta.music_name.slice(0, 45)
  const ver = perfVersion(meta.file_name)
  const verLabel = ver != null ? ` [v${ver}]` : ''
  return `${meta.composer.split(',')[0]} — "${name}"${verLabel}`
}

/** 'WAMozart_K265_3' → 'WAMozart_K265' */
export function pieceGroupId(fileName: string): string {
  const parts = fileName.split('_')
  return /^\d+$/.test(parts[parts.length - 1]) ? parts.slice(0, -1).join('_') : fileName
}

/** 'WAMozart_K265' → 'K.265', 'LBeethoven_OP34' → 'Op.34', etc. */
export function catalogNum(pieceId: string): string {
  const suffix = pieceId.split('_').slice(1).join('_')
  if (/^K\d/.test(suffix))    return `K.${suffix.slice(1)}`
  if (/^OP\d/.test(suffix))   return `Op.${suffix.slice(2)}`
  if (/^WOO\d/.test(suffix))  return `WoO.${suffix.slice(3)}`
  if (/^XVII/.test(suffix))   return `Hob.XVII:${suffix.replace('XVII', '')}`
  return suffix
}

/** Extract a concise title from the verbose music_name field */
export function pieceTitle(musicName: string): string {
  const q = musicName.match(/"([^"]+)"/)
  if (q) return q[1]
  const stripped = musicName.replace(/^[A-Z][a-zäöü\s]+(?:van\s|von\s)?[A-Z][a-z]+\s*[-–]\s*/u, '')
  const clean = stripped.replace(/,\s*(op|woo|k|hob)\.\s*[\d/]+.*/i, '').trim()
  return clean || musicName
}

/** Group a flat PieceMeta[] by pieceGroupId, sorted by version number */
export function groupPieces(pieces: PieceMeta[], composerKey: string) {
  const map = new Map<string, PieceMeta[]>()
  for (const p of pieces) {
    if (!p.file_name.startsWith(composerKey + '_')) continue
    const gid = pieceGroupId(p.file_name)
    if (!map.has(gid)) map.set(gid, [])
    map.get(gid)!.push(p)
  }
  return Array.from(map.entries()).map(([id, versions]) => ({
    id,
    musicName: versions[0].music_name,
    versions: versions.sort((a, b) => (perfVersion(a.file_name) ?? 0) - (perfVersion(b.file_name) ?? 0)),
  }))
}

export function durationLabel(data: PieceData): string {
  const s = data.metadata.total_duration_sec
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
