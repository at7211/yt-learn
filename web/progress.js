// Pure helper for the job card's progress bar. Units come from pipeline/build.py:
// one per segmentation chunk, VOCAB_UNITS (2) for the vocabulary call, INTRO_UNITS (1) for the intro card.
const VOCAB_UNITS = 2;
const INTRO_UNITS = 1;

function pctOf(p) {
  if (!p || typeof p.done !== 'number' || typeof p.total !== 'number' || !(p.total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

// -> { mode: 'indet' | 'det' | 'done' | 'error', pct, label }
export function barState(job, elapsedSec, lastPct = 0) {
  const secs = Math.max(0, Math.floor(elapsedSec || 0));
  if (!job) return { mode: 'indet', pct: 0, label: '正在建立工作…' };
  switch (job.state) {
    case 'queued':
    case 'capturing':
      return { mode: 'indet', pct: 0, label: '擷取字幕中… ' + secs + ' 秒' };
    case 'captured':
      return { mode: 'indet', pct: 0, label: '等待產課…' };
    case 'building': {
      const p = job.progress;
      if (!p || typeof p.phase !== 'string') return { mode: 'indet', pct: 0, label: '準備中…' };
      const pct = pctOf(p);
      const chunks = Math.max(0, (p.total | 0) - VOCAB_UNITS - INTRO_UNITS);
      let label;
      if (p.phase === 'segment') label = '切句 ' + p.done + '/' + chunks;
      else if (p.phase === 'vocab') label = '挑選單字';
      else if (p.phase === 'intro') label = '前情提要';
      else if (p.phase === 'finish') label = '收尾';
      else label = p.phase;
      return { mode: 'det', pct, label: label + '（' + pct + '%）' };
    }
    case 'done':
      return { mode: 'done', pct: 100, label: '完成' };
    case 'error':
      return { mode: 'error', pct: lastPct || 0, label: '' };
    default:
      return { mode: 'indet', pct: 0, label: String(job.state) };
  }
}
