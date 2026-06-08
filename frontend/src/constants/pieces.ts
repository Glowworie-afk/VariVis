export const COMPOSER_GROUPS = [
  { key: 'LBeethoven', label: 'Beethoven', zh: '贝多芬' },
  { key: 'WAMozart',   label: 'Mozart',    zh: '莫扎特' },
  { key: 'JHaydn',     label: 'Haydn',     zh: '海顿'   },
] as const

const PIECE_COLORS: Array<{ from: string; to: string }> = [
  { from: '#4361EE', to: '#7C3AED' },
  { from: '#06B6D4', to: '#10B981' },
  { from: '#F59E0B', to: '#EF4444' },
  { from: '#EC4899', to: '#8B5CF6' },
  { from: '#14B8A6', to: '#3B82F6' },
  { from: '#F97316', to: '#EAB308' },
]

export function pieceColor(idx: number) {
  return PIECE_COLORS[idx % PIECE_COLORS.length]
}
