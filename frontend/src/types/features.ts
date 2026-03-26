// VariVis — TypeScript interfaces matching backend JSON output

export interface DominantPitch {
  name: string       // e.g. "C", "G"
  cof_index: number  // position in circle-of-fifths order (0–11)
}

export interface CompressedFeatures {
  n_frames: number           // 64
  rms: number[]              // [64]  energy envelope
  spectral_centroid: number[] // [64]  brightness
  chroma_cof: number[][]     // [12][64]  chroma heatmap in COF order
  onset_count?: number[]     // [64]  onset count per frame — true local rhythmic density
                             //        (available after re-running extraction; absent in older JSON)
}

export interface SegmentFeatures {
  // ── Harmony / Tonality ──
  chroma_chromatic: number[]     // [12] chromatic order
  chroma_cof: number[]           // [12] circle-of-fifths order (sum ≈ 1)
  dominant_pitch: DominantPitch

  // ── Timbre ──
  mfcc_mean: number[]            // [13]
  mfcc_std: number[]             // [13]

  // ── Dynamics ──
  rms_mean: number
  rms_std: number
  rms_max: number
  dynamic_range_db: number

  // ── Brightness ──
  spectral_centroid_mean: number
  spectral_centroid_std: number

  // ── Rhythm ──
  onset_density: number          // onsets per second
  tempo: number                  // BPM (unreliable on very slow segments)

  // ── Texture ──
  spectral_contrast_mean: number[] // [7] bands
  zcr_mean: number
  spectral_flatness_mean: number
  tonnetz_mean: number[]         // [6]

  // ── Fixed-width compression (Method B) ──
  compressed: CompressedFeatures

  // ── Chord recognition (template matching — optional, requires re-extraction) ──
  chord_recognition?: {
    chord_sequence:    number[]    // [64] chord index per frame; 0-11 = major, 12-23 = minor (chromatic root order)
    transition_matrix: number[][]  // [24][24] count of chord i → chord j transitions
  }

  // ── Melodic pitch contour (pYIN — optional, added by add_pitch_contour.py) ──
  pitch_contour?: PitchContourData
}

export interface PitchContourData {
  n_frames: number            // 64
  midi: number[]              // [64] absolute MIDI values (0–127)
  midi_relative: number[]     // [64] semitones relative to tonic (0 = tonic, 7 = fifth, 12 = octave)
  beat_midi: number[]         // [N]  beat-aligned absolute MIDI (one value per beat)
  beat_midi_relative: number[]// [N]  beat-aligned relative semitones
  voiced_ratio: number        // fraction of frames with detected pitch (0–1)
  tonic_semitone: number      // 0=C, 1=C#, ..., 11=B
  tonic_name: string          // "C", "G", "F#", etc.
  is_major: boolean
  key_correlation: number     // Temperley profile fit quality (0–1, higher = more confident)
  ks_correlation?: number     // legacy field (kept for backwards compat with old JSON)
  error?: string
}

export interface Segment {
  label: string          // "T", "V1", ..., "C"
  index: number
  start_sec: number
  end_sec: number
  duration_sec: number
  features: SegmentFeatures
}

export interface PieceMetadata {
  folder: string
  file_name: string
  music_name: string
  composer: string
  period: string
  instrument: string
  variation_num: number
  chord_annotation: string[] | null
  sample_rate: number
  total_duration_sec: number
  extracted_at: string
  compressed_frames: number
  cof_order: number[]    // [0,7,2,9,4,11,6,1,8,3,10,5]
  cof_names: string[]    // ["C","G","D","A","E","B","F#","Db","Ab","Eb","Bb","F"]
}

export interface PieceData {
  metadata: PieceMetadata
  segments: Segment[]
}
