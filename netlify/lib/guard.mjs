// Shared request pipeline: config, store and error handling, so every
// function fails closed in the same way.
import { loadAuthConfig, ConfigError } from './config.mjs';
import { openStore, StoreUnavailable } from './store.mjs';
import { reply, ref, logEvent, RequestError } from './http.mjs';

export function handler(name, fn) {
  return async (req, context = {}) => {
    try {
      const cfg = loadAuthConfig();
      const store = openStore();
      return await fn(req, { cfg, store, context });
    } catch (e) {
      if (e instanceof RequestError) return reply(e.status, { error: e.message });
      if (e instanceof ConfigError) {
        const id = ref();
        logEvent('error', 'config_incomplete', { fn: name, kind: e.kind, missing: e.missing.join(' '), ref: id });
        return reply(503, { error: `Service is not configured. Ask the site owner to finish setup. (ref ${id})` });
      }
      if (e instanceof StoreUnavailable) {
        const id = ref();
        logEvent('error', 'store_unavailable', { fn: name, ref: id });
        return reply(503, { error: `Service temporarily unavailable. (ref ${id})` });
      }
      const id = ref();
      logEvent('error', 'unhandled', { fn: name, type: e && e.name ? String(e.name) : 'Error', ref: id });
      return reply(500, { error: `Unexpected error. (ref ${id})` });
    }
  };
}
