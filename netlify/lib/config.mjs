// Server-only configuration. Values come from Netlify environment variables
// (Functions scope). Nothing here is ever sent to the browser.

export class ConfigError extends Error {
  constructor(kind, missing) {
    super(`${kind} configuration incomplete`);
    this.kind = kind;       // 'auth' | 'source'
    this.missing = missing; // variable NAMES only (never values)
  }
}

function intEnv(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError('auth', [name]);
  return n;
}

// Required for every authenticated operation. Missing -> deny everything.
export function loadAuthConfig(env = process.env) {
  const missing = [];
  const password = env.SITE_PASSWORD || '';
  const secret = env.SESSION_SECRET || '';
  if (!password) missing.push('SITE_PASSWORD');
  if (secret.length < 32) missing.push('SESSION_SECRET');
  if (password && secret && password === secret) missing.push('SESSION_SECRET');
  if (missing.length) throw new ConfigError('auth', missing);

  return {
    password,
    secret,
    epoch: (env.SESSION_EPOCH || '1').slice(0, 64),
    sessionTtlSeconds: intEnv(env, 'SESSION_TTL_HOURS', 12, 1, 168) * 3600,
    login: {
      maxPerIp: intEnv(env, 'LOGIN_MAX_FAILURES_PER_IP', 10, 1, 1000),
      maxGlobal: intEnv(env, 'LOGIN_MAX_FAILURES_GLOBAL', 100, 1, 100000),
      windowMs: intEnv(env, 'LOGIN_WINDOW_MINUTES', 15, 1, 1440) * 60000,
    },
  };
}

const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,128}$/;

// Required only once a request is authenticated. Missing -> safe 503.
export function loadSourceConfig(env = process.env) {
  const missing = [];
  const apiKey = env.GOOGLE_SHEETS_API_KEY || '';
  const inventoryId = env.HPD_INVENTORY_SHEET_ID || '';
  const referenceId = env.PRODUCTS_MASTER_SHEET_ID || '';
  const gidRaw = env.PRODUCTS_MASTER_TAB_GID || '';
  if (!apiKey || !/^[\x21-\x7e]{10,200}$/.test(apiKey)) missing.push('GOOGLE_SHEETS_API_KEY');
  if (!SHEET_ID_RE.test(inventoryId)) missing.push('HPD_INVENTORY_SHEET_ID');
  if (!SHEET_ID_RE.test(referenceId)) missing.push('PRODUCTS_MASTER_SHEET_ID');
  if (!/^\d{1,12}$/.test(gidRaw)) missing.push('PRODUCTS_MASTER_TAB_GID');
  if (missing.length) throw new ConfigError('source', missing);

  let check;
  try {
    check = {
      budgetMs: intEnv(env, 'CHECK_BUDGET_MS', 9000, 2000, 25000),
      cacheSeconds: intEnv(env, 'CHECK_CACHE_SECONDS', 30, 0, 600),
      maxPerSession: intEnv(env, 'CHECK_MAX_PER_SESSION', 10, 1, 1000),
      maxGlobal: intEnv(env, 'CHECK_MAX_GLOBAL', 40, 1, 10000),
      windowMs: intEnv(env, 'CHECK_WINDOW_MINUTES', 10, 1, 1440) * 60000,
    };
  } catch (e) {
    throw new ConfigError('source', e.missing || ['CHECK_*']);
  }

  return {
    apiKey,
    inventoryId,
    referenceId,
    referenceGid: Number(gidRaw),
    check,
  };
}
