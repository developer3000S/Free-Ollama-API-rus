/* ===== FOA Gateway Admin Panel :: api.js ===== */
/* ====================================================================== */
/*  API Client                                                             */
/* ====================================================================== */
const API = {
  token: '',
  base: '',

  headers() {
    return { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  },

  async get(path, params) {
    const url = new URL(this.base + path, location.origin);
    if (params) Object.entries(params).forEach(([k,v]) => { if (v != null) url.searchParams.set(k, v); });
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw await this._err(res);
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(this.base + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body || {}) });
    if (!res.ok) throw await this._err(res);
    return res.json();
  },

  async patch(path, body) {
    const res = await fetch(this.base + path, { method: 'PATCH', headers: this.headers(), body: JSON.stringify(body || {}) });
    if (!res.ok) throw await this._err(res);
    return res.json();
  },

  async del(path) {
    const res = await fetch(this.base + path, { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw await this._err(res);
    return res.json();
  },

  async put(path, body) {
    const res = await fetch(this.base + path, { method: 'PUT', headers: this.headers(), body: JSON.stringify(body || {}) });
    if (!res.ok) throw await this._err(res);
    return res.json();
  },

  async _err(res) {
    try { const j = await res.json(); return new Error(j.error || j.detail || JSON.stringify(j)); }
    catch { return new Error(`HTTP ${res.status}`); }
  }
};
