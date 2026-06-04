export function ConnectionError({ error }: { error: string }) {
  return (
    <div style={{ padding: '24px 20px' }}>
      <div style={{ fontWeight: 700, color: 'var(--vv-red)', marginBottom: 8, fontSize: 13 }}>
        Cannot connect to VariVis API server
      </div>
      <div style={{ fontSize: 11, color: 'var(--vv-text-2)', lineHeight: 1.7, marginBottom: 14 }}>
        {error}
      </div>
      <div style={{
        padding: '10px 14px', borderRadius: 8, background: 'var(--vv-elevated)',
        fontSize: 11, fontFamily: 'monospace', lineHeight: 2,
        color: 'var(--vv-text)', border: '1px solid var(--vv-border)',
      }}>
        cd /Users/jiaxuan/Desktop/Music\ Project/VariVis/backend<br />
        source .venv/bin/activate<br />
        python -m uvicorn server:app --reload --port 8000
      </div>
    </div>
  )
}
