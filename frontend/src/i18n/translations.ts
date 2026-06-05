// Central source of truth for all bilingual UI strings.
// Dynamic strings with interpolation stay inline in components using `lang` from useLang().

const en = {
  // ── Sidebar ──────────────────────────────────────────────────────
  'sidebar.connecting':    'Connecting…',
  'sidebar.upload':        'Upload piece',
  'sidebar.temp-upload':   'Temp upload',

  // ── Piece state ───────────────────────────────────────────────────
  'piece.loading-features': 'Loading features…',
  'piece.loading':           'Loading…',
  'server.connecting':       'Connecting to server…',

  // ── Corpus view ───────────────────────────────────────────────────
  'corpus.segment-overview': 'Segment\nOverview',

  // ── Rhythm bubbles ────────────────────────────────────────────────
  'rhythm.start':                'S',
  'rhythm.end':                  'E',
  'rhythm.title':                'Rhythm Bubbles',
  'rhythm.avg-density':          'Avg density',
  'rhythm.legend.size':          'Size = loudness (RMS)',
  'rhythm.legend.opacity-local': 'Opacity = local onset density',
  'rhythm.legend.opacity-proxy': 'Opacity = segment avg density (|ΔRMS| proxy)',
  'rhythm.guide.loud-fast':      'Large + opaque = loud & fast',
  'rhythm.guide.loud-slow':      'Large + faded = loud but slow (sustained)',
  'rhythm.guide.soft-fast':      'Small + opaque = soft but fast',

  // ── Contour modal ─────────────────────────────────────────────────
  'contour.similarity':  'Contour similarity',
  'contour.close-hint':  'Click backdrop or press Esc to close.',

  // ── Pitch contour ─────────────────────────────────────────────────
  'pitch.click-hint': 'Click a card to enlarge · click another to overlay',

  // ── Harmonic analysis (MusicVisPage) ─────────────────────────────
  'harmonic.title':          'Harmonic Function Distribution',
  'harmonic.expand':         'Expand',
  'harmonic.collapse':       'Collapse',
  'harmonic.fn.tonic':       'Tonic',
  'harmonic.fn.subdominant': 'Subdominant',
  'harmonic.fn.dominant':    'Dominant',
  'harmonic.fn.other':       'Other',
  'harmonic.theme':          'Theme',
  'musicvis.key':            'Key',
  'musicvis.analysing':      '⏳ Analysing chords…',
  'musicvis.all':            'All',

  // ── Score page ────────────────────────────────────────────────────
  'score.title':      'Score View',
  'score.open-tab':   'Open in new tab ↗',
  'score.loading':    'Matching score…',
  'score.not-found':  'No matching score found',
  'score.imslp-list': 'Scores currently in IMSLP/:',
  'score.error':      'Could not connect to backend',

  // ── MDA analysis ─────────────────────────────────────────────────
  'mda.tree-title':       'Similarity Tree · Prim MST (penalty k)',
  'mda.gen0':             'Gen 0 · Theme',
  'mda.parent':           'Parent',
  'mda.feat.pitch':       'P',
  'mda.feat.rhythm':      'R',
  'mda.feat.harmony':     'H',
  'mda.grundgestalt':     'Grundgestalt · root',
  'mda.legend.title':     'Line color → penalty k between two segments',
  'mda.legend.very-sim':  'k < 0.30  very similar',
  'mda.legend.similar':   '0.30–0.50  similar',
  'mda.legend.moderate':  '0.50–0.70  moderate',
  'mda.legend.divergent': 'k > 0.70  divergent',

  // ── Mental landscape ─────────────────────────────────────────────
  'mental.title':              'Mental Landscape',
  'mental.pitch-mid':          'mid',
  'mental.legend.hue-key':     'Hue=key (CoF)',
  'mental.legend.rings':       'Rings=onset density (sparse→dense)',
  'mental.legend.size':        'Size=loudness (single channel)',
  'mental.legend.halo':        'Halo=timbre (Piercing→Dark)',
  'mental.legend.y-pitch':     'Y=melodic pitch',
  'mental.legend.dot-mode':    'Dot:bright=major·dark=minor',
  'mental.axis.valence':       'Valence →',
  'mental.axis.neg-valence':   '− Valence',
  'mental.axis.pos-valence':   '+ Valence',
  'mental.axis.high':          'High',
  'mental.axis.low':           'Low',
  'mental.axis.arousal':       'Arousal ↑',
  'mental.segment-emotions':   'Segment emotions',
  'mental.table.seg':          'Seg',
  'mental.table.key-valence':  'Key → Valence',
  'mental.table.rings':        '⭐ Rings → Rhythm density',
  'mental.table.loudness':     'Loudness → Power',
  'mental.table.timbre':       'Timbre → Halo (5 tiers)',
  'mental.table.melody':       '↕ Melody → Register',
  'mental.table.overall':      'Overall Label',
  'mental.mode.major':         'major',
  'mental.mode.minor':         'minor',
  'mental.skeleton.full':      'Full skeleton retained',
  'mental.skeleton.mostly':    'Skeleton mostly intact',
  'mental.skeleton.partial':   'Partial skeleton shift',
  'mental.skeleton.departed':  'Skeleton fully departed',
} as const

const zh: Record<keyof typeof en, string> = {
  // ── Sidebar ──────────────────────────────────────────────────────
  'sidebar.connecting':    '连接中…',
  'sidebar.upload':        '上传乐曲',
  'sidebar.temp-upload':   '临时上传',

  // ── Piece state ───────────────────────────────────────────────────
  'piece.loading-features': '加载特征中…',
  'piece.loading':           '加载中…',
  'server.connecting':       '正在连接服务器…',

  // ── Corpus view ───────────────────────────────────────────────────
  'corpus.segment-overview': '变奏\n概览',

  // ── Rhythm bubbles ────────────────────────────────────────────────
  'rhythm.start':                '起',
  'rhythm.end':                  '终',
  'rhythm.title':                '节奏气泡 · Rhythm Bubbles',
  'rhythm.avg-density':          '段均密度',
  'rhythm.legend.size':          '大小 = 响度（RMS）',
  'rhythm.legend.opacity-local': '透明度 = 局部起音密度（次/秒）',
  'rhythm.legend.opacity-proxy': '透明度 = 段均起音密度（|ΔRMS| 代理）',
  'rhythm.guide.loud-fast':      '大圆 + 深色 = 响且快',
  'rhythm.guide.loud-slow':      '大圆 + 浅色 = 响但慢（长音）',
  'rhythm.guide.soft-fast':      '小圆 + 深色 = 轻但快',

  // ── Contour modal ─────────────────────────────────────────────────
  'contour.similarity':  '旋律轮廓相似度',
  'contour.close-hint':  '点击背景或按 Esc 关闭',

  // ── Pitch contour ─────────────────────────────────────────────────
  'pitch.click-hint': '点击卡片放大 · 再点另一张叠加对比',

  // ── Harmonic analysis (MusicVisPage) ─────────────────────────────
  'harmonic.title':          '和声功能分布',
  'harmonic.expand':         '展开',
  'harmonic.collapse':       '折叠',
  'harmonic.fn.tonic':       '主功能',
  'harmonic.fn.subdominant': '下属功能',
  'harmonic.fn.dominant':    '属功能',
  'harmonic.fn.other':       '其他',
  'harmonic.theme':          '主题',
  'musicvis.key':            '调性',
  'musicvis.analysing':      '⏳ 分析和弦…',
  'musicvis.all':            '全部',

  // ── Score page ────────────────────────────────────────────────────
  'score.title':      '乐谱视图',
  'score.open-tab':   '新窗口打开 ↗',
  'score.loading':    '正在匹配乐谱…',
  'score.not-found':  '暂无匹配乐谱',
  'score.imslp-list': '目录中现有的乐谱：',
  'score.error':      '无法连接后端服务',

  // ── MDA analysis ─────────────────────────────────────────────────
  'mda.tree-title':       '相似度树 · Prim MST (k 值距离)',
  'mda.gen0':             'Gen 0 · 主题',
  'mda.parent':           '祖代',
  'mda.feat.pitch':       '音高',
  'mda.feat.rhythm':      '节奏',
  'mda.feat.harmony':     '和声',
  'mda.grundgestalt':     'Grundgestalt · 根节点',
  'mda.legend.title':     '连线颜色 / 粗细 → 两段之间的惩罚值 k',
  'mda.legend.very-sim':  'k < 0.30  极相似',
  'mda.legend.similar':   '0.30–0.50  较相似',
  'mda.legend.moderate':  '0.50–0.70  中等差异',
  'mda.legend.divergent': 'k > 0.70  差异大',

  // ── Mental landscape ─────────────────────────────────────────────
  'mental.title':              '心理图景 · Mental Landscape',
  'mental.pitch-mid':          '中音',
  'mental.legend.hue-key':     '色相=调性（五度圈）',
  'mental.legend.rings':       '同心环=节奏密度 (稀疏→致密)',
  'mental.legend.size':        '大小=响度 (单通道)',
  'mental.legend.halo':        '光晕=音色 (尖锐→厚重)',
  'mental.legend.y-pitch':     '纵位=旋律音高',
  'mental.legend.dot-mode':    '中心点:亮=大调 暗=小调',
  'mental.axis.valence':       '效价 →',
  'mental.axis.neg-valence':   '负效价',
  'mental.axis.pos-valence':   '正效价',
  'mental.axis.high':          '高唤醒',
  'mental.axis.low':           '低唤醒',
  'mental.axis.arousal':       '唤醒度 ↑',
  'mental.segment-emotions':   '各段情感坐标',
  'mental.table.seg':          '变奏',
  'mental.table.key-valence':  '调性→情感效价',
  'mental.table.rings':        '⭐ 同心环→节奏密度',
  'mental.table.loudness':     '响度→力量感',
  'mental.table.timbre':       '音色→光晕 (5档)',
  'mental.table.melody':       '↕ 旋律→音域',
  'mental.table.overall':      '综合标签',
  'mental.mode.major':         '大调',
  'mental.mode.minor':         '小调',
  'mental.skeleton.full':      '结构完全保留',
  'mental.skeleton.mostly':    '骨架基本稳固',
  'mental.skeleton.partial':   '部分结构偏移',
  'mental.skeleton.departed':  '骨架已完全离调',
}

export const translations = { en, zh } as const
export type TKey = keyof typeof en
