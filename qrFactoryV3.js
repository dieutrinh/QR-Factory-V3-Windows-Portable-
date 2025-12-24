// qrFactory V3 - API helper (works online + Electron preload bridge)
(function(){
  async function fetchJson(url, options){
    const r = await fetch(url, {credentials:"same-origin", ...options});
    const txt = await r.text();
    let data;
    try { data = txt ? JSON.parse(txt) : {}; } catch(e){ data = { raw: txt }; }
    if(!r.ok){
      const msg = (data && (data.error||data.message)) ? (data.error||data.message) : `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // Prefer Electron bridge if present; fallback to fetch
  async function apiGet(url){
    if (window.qrFactory && typeof window.qrFactory.apiGet === "function") return window.qrFactory.apiGet(url);
    return fetchJson(url, {method:"GET"});
  }
  async function apiPost(url, body){
    if (window.qrFactory && typeof window.qrFactory.apiPost === "function") return window.qrFactory.apiPost(url, body);
    return fetchJson(url, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body||{})});
  }

  window.qrFactoryV3 = { apiGet, apiPost };
})();
