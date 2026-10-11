// Hash-based client-side router. Owns window.location.hash and the hashchange
// event. parseHash/buildHash are PURE and round-trip
// (buildHash(parseHash(h)) === normalized(h)); encode-on-write guarantees the
// path/query split stays unambiguous. Resolution/redirect rules depend on the
// injected `mode` and `isMaster`; the router is the SOLE writer of
// sessionStorage 'pm2monitor.lastAgent'. No DOM-render logic lives here beyond
// dispatch to the injected app.renderRoute(route).

const LAST_AGENT_KEY = 'pm2monitor.lastAgent';

/**
 * Parse a location hash into a typed route object. Dynamic segments are decoded
 * LAST; a malformed %-escape throws URIError (left to propagate so the caller
 * treats it as no-selection + redirect).
 *
 * @param {string} hash raw location.hash (may include leading '#')
 * @returns {{view:'processes'|'fleet'|'settings', agentId:(string|null), name:(string|null), filter:('problems'|null)}}
 */
export function parseHash(hash) {
  // 1. Strip leading '#' and an optional leading '/'.
  let frag = String(hash || '');
  if (frag.startsWith('#')) frag = frag.slice(1);
  if (frag.startsWith('/')) frag = frag.slice(1);

  // 2. Split on the FIRST literal '?' into pathPart / queryPart.
  const qIdx = frag.indexOf('?');
  const pathPart = qIdx === -1 ? frag : frag.slice(0, qIdx);
  const queryPart = qIdx === -1 ? '' : frag.slice(qIdx + 1);

  // 3. Parse query; honor filter ONLY when exactly 'problems'.
  const params = new URLSearchParams(queryPart);
  const filter = params.get('filter') === 'problems' ? 'problems' : null;

  // 4. Split pathPart on '/'.
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  const head = segments[0] || '';

  // 5. Decode dynamic segments LAST (may throw URIError).
  if (head === 'processes') {
    const name = segments[1] !== undefined ? decodeURIComponent(segments[1]) : null;
    return { view: 'processes', agentId: null, name, filter };
  }
  if (head === 'fleet') {
    if (segments[1] === undefined) {
      return { view: 'fleet', agentId: null, name: null, filter };
    }
    const agentId = decodeURIComponent(segments[1]);
    const name = segments[2] !== undefined ? decodeURIComponent(segments[2]) : null;
    return { view: 'processes', agentId, name, filter };
  }
  if (head === 'settings') {
    return { view: 'settings', agentId: null, name: null, filter };
  }
  // Unknown.
  return { view: null, agentId: null, name: null, filter };
}

/**
 * Build a location hash (including leading '#') from a route object. Dynamic
 * segments are encodeURIComponent'd; '?filter=problems' is appended only when
 * route.filter === 'problems'. buildHash(parseHash(h)) round-trips.
 *
 * @param {{view:string, agentId?:(string|null), name?:(string|null), filter?:(string|null)}} route
 * @returns {string}
 */
export function buildHash(route) {
  const { view, agentId, name, filter } = route || {};
  let path;
  if (view === 'fleet') {
    path = '/fleet';
  } else if (view === 'settings') {
    path = '/settings';
  } else {
    // processes view: an agentId renders the fleet drill-down form.
    if (agentId) {
      path = `/fleet/${encodeURIComponent(agentId)}`;
      if (name) path += `/${encodeURIComponent(name)}`;
    } else {
      path = '/processes';
      if (name) path += `/${encodeURIComponent(name)}`;
    }
  }
  const query = filter === 'problems' ? '?filter=problems' : '';
  return `#${path}${query}`;
}

/**
 * The hash-driven router.
 */
export class Router {
  /**
   * @param {object} opts
   * @param {'standalone'|'server'} opts.mode run mode discovered by app.js
   * @param {boolean} [opts.isMaster] whether Settings is permitted
   * @param {{renderRoute:(route:object)=>void}} opts.app render callback host
   */
  constructor({ mode, isMaster = false, app }) {
    this.mode = mode;
    this.isMaster = isMaster;
    this.app = app;
    this._onHashChange = this._onHashChange.bind(this);
  }

  /** The mode default hash. */
  defaultHash() {
    return this.mode === 'server' ? '#/fleet' : '#/processes';
  }

  /**
   * Resolve the current hash into a route, performing redirects via
   * location.replace when needed. Returns the route to render, or null when a
   * redirect was issued (the replace re-fires hashchange, which re-enters here).
   * @returns {object|null}
   */
  resolve() {
    let route;
    try {
      route = parseHash(window.location.hash);
    } catch (err) {
      // Malformed %-escape -> treat as no selection, redirect to mode default.
      if (err instanceof URIError) {
        this._replace(this.defaultHash());
        return null;
      }
      throw err;
    }

    // Unknown / empty hash -> mode default.
    if (route.view === null) {
      this._replace(this.defaultHash());
      return null;
    }

    if (this.mode === 'standalone') {
      // Standalone: any fleet* route redirects to #/processes.
      if (route.view === 'fleet' || (route.view === 'processes' && route.agentId)) {
        this._replace('#/processes');
        return null;
      }
      if (route.view === 'settings' && !this.isMaster) {
        this._replace(this.defaultHash());
        return null;
      }
      return route;
    }

    // Server mode.
    if (route.view === 'processes' && !route.agentId) {
      // Bare #/processes (or #/processes/:name) has no data source; resolve it.
      const last = sessionStorage.getItem(LAST_AGENT_KEY);
      this._replace(last ? `#/fleet/${encodeURIComponent(last)}` : '#/fleet');
      return null;
    }
    if (route.view === 'settings' && !this.isMaster) {
      this._replace(this.defaultHash());
      return null;
    }

    // Single-writer lastAgent: write the DECODED agentId on resolved entry into
    // a #/fleet/:agentId[/:name] route (server mode only).
    if (route.view === 'processes' && route.agentId) {
      sessionStorage.setItem(LAST_AGENT_KEY, route.agentId);
    }
    return route;
  }

  /** Read the initial hash (or redirect to the mode default), then render. */
  start() {
    window.addEventListener('hashchange', this._onHashChange);
    if (!window.location.hash) {
      this._replace(this.defaultHash());
      return;
    }
    const route = this.resolve();
    if (route) this.app.renderRoute(route);
  }

  /** Stop listening for hashchange. */
  stop() {
    window.removeEventListener('hashchange', this._onHashChange);
  }

  _onHashChange() {
    const route = this.resolve();
    if (route) this.app.renderRoute(route);
  }

  _replace(hash) {
    window.location.replace(hash);
  }
}
