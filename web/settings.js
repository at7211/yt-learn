// Pure helpers for the home page's build settings. Mirrors pipeline/settings.py (the server is the
// authority; this only keeps the form honest and names what is selected).
export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const WORKERS_MIN = 1;
export const WORKERS_MAX = 8;
export const DEFAULTS = { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'default', workers: 4, budgetUsd: null };

// The four language-model sources. `key` names the vendor in GET /settings `keys` / `models`.
export const PROVIDERS = {
  'claude-cli': { label: 'Claude CLI（本機登入）', short: 'Claude CLI', key: null },
  'codex-cli': { label: 'Codex CLI（本機登入）', short: 'Codex CLI', key: null },
  'anthropic-api': { label: 'Anthropic API key', short: 'Anthropic API', key: 'anthropic' },
  'openai-api': { label: 'OpenAI API key', short: 'OpenAI API', key: 'openai' },
};

export const PRESETS = {
  fast: { label: '快', note: '最快也最省，中譯與挑字會粗一點', settings: { model: 'claude-haiku-5-5', effort: 'low', workers: 8 } },
  standard: { label: '標準', note: '預設，速度與品質平衡', settings: { model: 'claude-sonnet-5-5', effort: 'default', workers: 4 } },
  fine: { label: '細緻', note: '最慢也最貴，翻譯與挑字最好', settings: { model: 'claude-opus-5-5', effort: 'high', workers: 4 } },
};

export const KEYS = ['provider', 'model', 'effort', 'workers', 'budgetUsd'];
const OPTIONAL = ['provider', 'budgetUsd']; // missing → DEFAULTS value
const PRESET_KEYS = ['model', 'effort', 'workers'];

function ids(models, key) {
  const got = (models || {})[key];
  return Array.isArray(got) ? got.filter((i) => typeof i === 'string') : [];
}

// The model choices for `provider` given the cached lists from GET /settings `models`.
// codex-cli has none: the model there follows Codex's own configuration.
export function modelsFor(provider, models = {}) {
  if (provider === 'codex-cli') return [];
  if (provider === 'openai-api') return ids(models, 'openai');
  if (provider === 'anthropic-api') return [...MODELS, ...ids(models, 'anthropic').filter((m) => !MODELS.includes(m))];
  return [...MODELS];
}

function modelOk(provider, model, models) {
  if (typeof model !== 'string' || !model) return false;
  if (provider === 'codex-cli') return true;
  return modelsFor(provider, models).includes(model);
}

function modelError(provider) {
  if (provider === 'openai-api') return 'model 不在 OpenAI 模型清單裡，請先測試連線取得模型清單';
  if (provider === 'anthropic-api') return `model must be one of ${MODELS.join(', ')} or in the Anthropic model list`;
  if (provider === 'codex-cli') return 'model must be a non-empty string';
  return `model must be one of ${MODELS.join(', ')}`;
}

// Same rules as the server (full, not partial): every key required except provider (missing →
// claude-cli) and budgetUsd (missing → null); model checked against the provider's rules using the
// cached lists `models`; integer 1–8 workers; budgetUsd null or a positive number; no unknown keys.
// Returns { settings, errors } with only the valid keys in settings.
export function normalize(obj, models = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { settings: {}, errors: ['settings must be a JSON object'] };
  }
  const settings = {};
  const errors = [];
  for (const k of KEYS) { // provider precedes model, so the model check sees the validated provider
    if (!(k in obj)) {
      if (OPTIONAL.includes(k)) settings[k] = DEFAULTS[k];
      else errors.push(k + ' is required');
      continue;
    }
    const v = obj[k];
    if (k === 'provider') {
      if (typeof v === 'string' && Object.hasOwn(PROVIDERS, v)) settings.provider = v;
      else errors.push(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
    } else if (k === 'model') {
      const provider = settings.provider || 'claude-cli';
      if (modelOk(provider, v, models)) settings.model = v; else errors.push(modelError(provider));
    } else if (k === 'effort') {
      if (EFFORTS.includes(v)) settings.effort = v; else errors.push(`effort must be one of ${EFFORTS.join(', ')}`);
    } else if (k === 'workers') {
      if (Number.isInteger(v) && v >= WORKERS_MIN && v <= WORKERS_MAX) settings.workers = v;
      else errors.push(`workers must be an integer ${WORKERS_MIN}-${WORKERS_MAX}`);
    } else if (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      settings.budgetUsd = v;
    } else {
      errors.push('budgetUsd must be null or a positive number');
    }
  }
  for (const k of Object.keys(obj)) if (!KEYS.includes(k)) errors.push(`unknown setting '${k}'`);
  return { settings, errors };
}

export function presetOf(s) {
  if (!s) return null;
  for (const [name, p] of Object.entries(PRESETS)) {
    if (PRESET_KEYS.every((k) => p.settings[k] === s[k])) return name;
  }
  return null;
}

// "claude-sonnet-5-5" -> "sonnet" for the three built-in models; any other name (a listed API model
// such as "claude-opus-6-0", an OpenAI model) is shown in full so two versions never read the same.
export function shortModel(model) {
  const m = MODELS.includes(model) ? /^claude-([a-z]+)-/.exec(model) : null;
  return m ? m[1] : String(model || '');
}

// One line for the collapsed <summary>: 「設定：Claude CLI・標準・sonnet・4 併行」; effort shows only when set.
export function summary(s) {
  const src = PROVIDERS[s.provider] || PROVIDERS['claude-cli'];
  const p = presetOf(s);
  const parts = [src.short, p ? PRESETS[p].label : '自訂', shortModel(s.model)];
  if (s.effort && s.effort !== 'default') parts.push('effort ' + s.effort);
  parts.push(s.workers + ' 併行');
  return '設定：' + parts.join('・');
}

// The monthly-cap input: blank is no cap (null), a finite number is the cap, and anything else, including a
// type=number input whose validity.badInput is set (its value then reads ''), is refused rather than
// saved as null, which would silently remove the cap.
export function parseBudget(raw, badInput) {
  const text = String(raw == null ? '' : raw).trim();
  if (badInput) return { error: '每月上限不是數字' };
  if (text === '') return { value: null };
  const n = Number(text);
  return Number.isFinite(n) ? { value: n } : { error: '每月上限不是數字' };
}

// 0.1234 -> 「約 $0.12」; null / undefined (model not in the price table) -> 「牌價未知」.
export function fmtUsd(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '牌價未知';
  return '約 $' + x.toFixed(2);
}

// The #usage-line text from GET /usage: only API spend counts against the budget, and API builds
// whose model has no price (unpricedApiRows) are named because the cap cannot see them.
export function budgetText(u) {
  const api = typeof u.apiUsd === 'number' ? u.apiUsd : 0;
  const cap = typeof u.budgetUsd === 'number' ? '／上限 $' + u.budgetUsd.toFixed(2) : '';
  const n = Number.isInteger(u.unpricedApiRows) && u.unpricedApiRows > 0 ? u.unpricedApiRows : 0;
  return '本月 API ' + fmtUsd(api) + cap + '（本機估算）' + (n ? '・本月有 ' + n + ' 次產課牌價未知，未計入上限' : '');
}
