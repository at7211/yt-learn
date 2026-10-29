// Pure helpers for the home page's build settings. Mirrors pipeline/settings.py (the server is the
// authority; this only keeps the form honest and names what is selected).
export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const WORKERS_MIN = 1;
export const WORKERS_MAX = 8;
export const DEFAULTS = { model: 'claude-sonnet-5-5', effort: 'default', workers: 4 };

export const PRESETS = {
  fast: { label: '快', note: '最快也最省，中譯與挑字會粗一點', settings: { model: 'claude-haiku-5-5', effort: 'low', workers: 8 } },
  standard: { label: '標準', note: '預設，速度與品質平衡', settings: { model: 'claude-sonnet-5-5', effort: 'default', workers: 4 } },
  fine: { label: '細緻', note: '最慢也最貴，翻譯與挑字最好', settings: { model: 'claude-opus-5-5', effort: 'high', workers: 4 } },
};

const KEYS = ['model', 'effort', 'workers'];

// Same rules as the server: every key required, whitelist for model/effort, integer 1–8 workers,
// no unknown keys. Returns { settings, errors } with only the valid keys in settings.
export function normalize(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { settings: {}, errors: ['settings must be a JSON object'] };
  }
  const settings = {};
  const errors = [];
  for (const k of KEYS) {
    if (!(k in obj)) { errors.push(k + ' is required'); continue; }
    const v = obj[k];
    if (k === 'workers') {
      if (Number.isInteger(v) && v >= WORKERS_MIN && v <= WORKERS_MAX) settings.workers = v;
      else errors.push(`workers must be an integer ${WORKERS_MIN}-${WORKERS_MAX}`);
    } else {
      const ok = (k === 'model' ? MODELS : EFFORTS).includes(v);
      if (ok) settings[k] = v; else errors.push(`${k} must be one of ${(k === 'model' ? MODELS : EFFORTS).join(', ')}`);
    }
  }
  for (const k of Object.keys(obj)) if (!KEYS.includes(k)) errors.push(`unknown setting '${k}'`);
  return { settings, errors };
}

export function presetOf(s) {
  if (!s) return null;
  for (const [name, p] of Object.entries(PRESETS)) {
    if (KEYS.every((k) => p.settings[k] === s[k])) return name;
  }
  return null;
}

// "claude-sonnet-5-5" -> "sonnet"
export function shortModel(model) {
  const m = /^claude-([a-z]+)-/.exec(model || '');
  return m ? m[1] : String(model || '');
}

// One line for the collapsed <summary>: 「設定：標準・sonnet・4 併行」; effort shows only when set.
export function summary(s) {
  const p = presetOf(s);
  const parts = [p ? PRESETS[p].label : '自訂', shortModel(s.model)];
  if (s.effort && s.effort !== 'default') parts.push('effort ' + s.effort);
  parts.push(s.workers + ' 併行');
  return '設定：' + parts.join('・');
}
