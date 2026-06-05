import type { PieceMeta } from '@/api/pieceApi'
import type { PieceData } from './features'

export type Lang = 'zh' | 'en'

export type PieceViewState = 'loading' | 'ready' | 'not-extracted' | 'error'

export interface LoadedPiece {
  meta:      PieceMeta
  data:      PieceData | null
  viewState: PieceViewState
  error?:    string
}
