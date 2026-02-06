const API = "https://models.dev/api.json";
const LOGO = (id) => `https://models.dev/logos/${id}.svg`;
const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ROW_H = 34, OVERSCAN = 8;

// ── Helpers ──────────────────────────────────────────────────

const ESC_RE = /[&<>"']/g;
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const dash = (v, f) => v == null ? "—" : f(v);
const esc = (s = "") => String(s ?? "").replace(ESC_RE, (c) => ESC_MAP[c]);
const fmt = (n) => dash(n, (v) => v.toLocaleString("en-US"));
const cost = (n) => dash(n, (v) => `$${v.toFixed(2)}`);
const yn = (v) => v ? "✓" : "—";

function flashCopy(btn, orig, label) {
  btn.innerHTML = label ? `${CHECK_SVG} ${label}` : CHECK_SVG;
  btn.classList.add("copied");
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove("copied"); }, 1500);
}

function copyBtn(sel, text) {
  const btn = typeof sel === "string" ? this.querySelector(sel) : sel;
  const orig = btn.innerHTML;
  const isFn = typeof text === "function";
  const getText = isFn ? text : () => text;
  btn.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(getText()); flashCopy(btn, orig, isFn ? "Copied!" : null); };
}

function showDialog(el, closeId) {
  const dlg = el.closest("dialog");
  dlg.showModal();
  el.querySelector(`#${closeId}`).onclick = () => dlg.close();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
}

// ── State ────────────────────────────────────────────────────

const S = {
  providers: {}, all: [], filtered: [], index: [], sortKeys: {},
  sort: { col: "provider", dir: 1 }, compare: new Set(),
};

const bus = new EventTarget();
const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));
const on = (n, fn) => bus.addEventListener(n, (e) => fn(e.detail));

// ── Columns (for thead + sort) ───────────────────────────────

const COLS = [
  { id: "cmp" },
  { id: "provider",  label: "Provider",  get: (m) => m.provider,          count: true },
  { id: "name",      label: "Model",     get: (m) => m.name,              count: true },
  { id: "id",        label: "Model ID",  get: (m) => m.id },
  { id: "family",    label: "Family",    get: (m) => m.family ?? "—" },
  { id: "input",     label: "Input /M",  get: (m) => m.cost?.input,       num: true },
  { id: "output",    label: "Output /M", get: (m) => m.cost?.output,      num: true },
  { id: "context",   label: "Context",   get: (m) => m.limit?.context,    num: true },
  { id: "maxOut",    label: "Max Out",   get: (m) => m.limit?.output,     num: true },
  { id: "reasoning", label: "Reasoning", get: (m) => m.reasoning,         num: true },
  { id: "tools",     label: "Tools",     get: (m) => m.tool_call,         num: true },
  { id: "struct",    label: "Struct",    get: (m) => m.structured_output, num: true },
  { id: "weights",   label: "Weights",   get: (m) => m.open_weights },
];

const spacerRow = (h) => h > 0 ? `<tr><td colspan="${COLS.length}" style="height:${h}px;border:none;padding:0"></td></tr>` : "";

// ── Load ─────────────────────────────────────────────────────

async function load() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  S.providers = await res.json();

  for (const [pid, p] of Object.entries(S.providers)) {
    for (const m of Object.values(p.models ?? {}))
      S.all.push({ ...m, pid, provider: p.name });
  }

  for (const m of S.all) {
    m._key = `${m.pid}/${m.id}`;
    m._e = { p: esc(m.provider), n: esc(m.name), i: esc(m.id), f: esc(m.family ?? "—") };
  }
  S.index = S.all.map((m) => `${m.provider}\t${m.pid}\t${m.name}\t${m.id}\t${m.family}`.toLowerCase());
  for (const c of COLS) if (c.get) S.sortKeys[c.id] = S.all.map(c.get);
  S.filtered = S.all;
}

// ── Table ────────────────────────────────────────────────────

class ModelTable extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="loading"><div class="spinner"></div><div>Loading…</div></div>`;
    on("loaded", () => this.init());
    on("sorted", () => this.refresh());
    on("filtered", () => { this.counts(); this.scrollTop = 0; this.refresh(); });
    on("compare-changed", () => this.refresh());
  }

  init() {
    this.sort();
    this.innerHTML = `<table><thead><tr>${this.thead()}</tr></thead><tbody></tbody></table>`;
    this.tb = this.querySelector("tbody");
    this.map = new Map(S.all.map((m) => [m._key, m]));
    this.countName = document.getElementById("count-name");
    this.countProvider = document.getElementById("count-provider");
    this.counts();
    this._w = [-1, -1]; this._raf = 0;
    this.addEventListener("scroll", () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); });
    this.listen();
    this.draw();
    this.widths();
  }

  refresh() { this.sort(); this.querySelector("thead tr").innerHTML = this.thead(); this._w = [-1, -1]; this.draw(); }

  draw() {
    const n = S.filtered.length;
    const s = Math.max(0, (this.scrollTop / ROW_H | 0) - OVERSCAN);
    const e = Math.min(n, s + Math.ceil(this.clientHeight / ROW_H) + OVERSCAN * 2);
    if (s === this._w[0] && e === this._w[1]) return;
    this._w = [s, e];
    const rows = [spacerRow(s * ROW_H)];
    for (let i = s; i < e; i++) rows.push(this.row(S.filtered[i]));
    rows.push(spacerRow(Math.max(0, (n - e) * ROW_H)));
    this.tb.innerHTML = rows.join("");
  }

  row(m) {
    const k = m._key, sel = S.compare.has(k);
    return `<tr data-key="${k}" class="${sel ? "selected" : ""}${m.status === "deprecated" ? " status-deprecated" : ""}">` +
      `<td><input type="checkbox" class="compare-cb" data-key="${k}"${sel ? " checked" : ""}></td>` +
      `<td>${m._e.p}</td><td><a class="model-link" data-key="${k}">${m._e.n}</a></td>` +
      `<td class="mono dim id-cell"><span class="id-wrap">${m._e.i}<button class="icon-btn sm copy-id" data-id="${m._e.i}">${COPY_SVG}</button></span></td><td>${m._e.f}</td>` +
      `<td class="num">${cost(m.cost?.input)}</td><td class="num">${cost(m.cost?.output)}</td>` +
      `<td class="num">${fmt(m.limit?.context)}</td><td class="num">${fmt(m.limit?.output)}</td>` +
      `<td class="bool ${m.reasoning ? "yes" : "no"}">${yn(m.reasoning)}</td>` +
      `<td class="bool ${m.tool_call ? "yes" : "no"}">${yn(m.tool_call)}</td>` +
      `<td class="bool ${m.structured_output ? "yes" : "no"}">${yn(m.structured_output)}</td>` +
      `<td>${m.open_weights ? "Open" : "Closed"}</td></tr>`;
  }

  thead() {
    return COLS.map((c) => {
      if (!c.label) return "<th></th>";
      const sorted = S.sort.col === c.id;
      const cls = (c.num ? " num" : "") + (sorted ? " sorted" : "");
      const count = c.count ? ` <span class="col-count" id="count-${c.id}"></span>` : "";
      const arrow = sorted ? (S.sort.dir === 1 ? "▲" : "▼") : "▲";
      return `<th class="${cls}" data-col="${c.id}">${c.label}${count} <span class="sort-arrow">${arrow}</span></th>`;
    }).join("");
  }

  widths() {
    const ch = 7.5, cm = 7.2, pd = 28;
    let p = 8, n = 5, i = 8, f = 6;
    for (const m of S.all) { p = Math.max(p, m.provider.length); n = Math.max(n, m.name.length); i = Math.max(i, m.id.length); f = Math.max(f, (m.family ?? "").length); }
    const w = [34, Math.min(p * ch + pd, 200), Math.min(n * ch + pd, 280), Math.min(i * cm + pd + 30, 350), Math.min(f * ch + pd, 160), 90, 90, 100, 90, 85, 65, 65, 75];
    const cg = document.createElement("colgroup");
    w.forEach((v) => { const c = document.createElement("col"); c.style.width = `${v}px`; cg.appendChild(c); });
    const t = this.querySelector("table"); t.style.tableLayout = "fixed"; t.prepend(cg);
  }

  counts() {
    if (this.countName) this.countName.textContent = `(${S.filtered.length})`;
    if (this.countProvider) this.countProvider.textContent = `(${new Set(S.filtered.map((m) => m.pid)).size})`;
  }

  listen() {
    this.querySelector("thead").onclick = (e) => {
      const th = e.target.closest("th[data-col]"); if (!th) return;
      S.sort.dir = S.sort.col === th.dataset.col ? S.sort.dir * -1 : 1;
      S.sort.col = th.dataset.col;
      emit("sorted");
    };
    this.tb.onclick = (e) => {
      const cb = e.target.closest(".compare-cb");
      if (cb) { e.stopPropagation(); toggleCompare(cb.dataset.key, cb); emit("compare-changed"); return; }
      const cp = e.target.closest(".copy-id");
      if (cp) { e.stopPropagation(); const orig = cp.innerHTML; navigator.clipboard.writeText(cp.dataset.id); flashCopy(cp, orig); return; }
      const a = e.target.closest(".model-link");
      if (a) { e.preventDefault(); const m = this.map.get(a.dataset.key); if (m) emit("open-detail", m); }
    };
  }

  sort() {
    const col = COLS.find((c) => c.id === S.sort.col);
    if (!col?.get) return;
    const dir = S.sort.dir, keys = S.sortKeys[col.id], n = S.all.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => {
      let va = keys[a], vb = keys[b];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      if (typeof va === "boolean") { va = +va; vb = +vb; }
      return typeof va === "string" ? (va < vb ? -dir : va > vb ? dir : 0) : (va - vb) * dir;
    });
    const pa = S.all.slice(), pi = S.index.slice(), pk = {};
    for (const k in S.sortKeys) pk[k] = S.sortKeys[k].slice();
    for (let i = 0; i < n; i++) { const s = idx[i]; S.all[i] = pa[s]; S.index[i] = pi[s]; for (const k in S.sortKeys) S.sortKeys[k][i] = pk[k][s]; }
    if (S.filtered.length < n) { const set = new Set(S.filtered.map((m) => m._key)); S.filtered = S.all.filter((m) => set.has(m._key)); }
    else S.filtered = S.all;
  }
}

customElements.define("model-table", ModelTable);

function toggleCompare(key, cb) {
  if (S.compare.has(key)) {
    S.compare.delete(key);
    return;
  }
  if (S.compare.size < 4) {
    S.compare.add(key);
    return;
  }
  cb.checked = false;
}

function bestIndexes(values, dir) {
  const ok = values.filter((v) => v != null);
  if (!ok.length) return new Set();
  const target = dir === "lower" ? Math.min(...ok) : Math.max(...ok);
  const best = new Set();
  values.forEach((v, i) => { if (v === target) best.add(i); });
  return best;
}

class ModelDetail extends HTMLElement {
  connectedCallback() { on("open-detail", (m) => this.show(m)); }

  show(m) {
    const p = S.providers[m.pid];
    const b = (c, cls, t) => c ? `<span class="badge ${cls}">${t}</span>` : "";
    const kv = (l, v) => `<tr><td class="kl">${esc(l)}</td><td class="kv">${esc(String(v))}</td></tr>`;

    const costs = [["Input", cost(m.cost?.input)], ["Output", cost(m.cost?.output)],
      m.cost?.reasoning != null && ["Reasoning", cost(m.cost.reasoning)],
      m.cost?.cache_read != null && ["Cache Read", cost(m.cost.cache_read)],
      m.cost?.cache_write != null && ["Cache Write", cost(m.cost.cache_write)],
      m.cost?.input_audio != null && ["Audio In", cost(m.cost.input_audio)],
      m.cost?.output_audio != null && ["Audio Out", cost(m.cost.output_audio)],
    ].filter(Boolean);

    this.innerHTML = `
      <button class="dialog-close" id="cd">✕</button>
      <div class="d-hero">
        <div class="d-provider"><img src="${LOGO(m.pid)}" alt="" onerror="this.style.display='none'"> ${esc(p?.name ?? m.pid)}</div>
        <h2 class="d-name">${m._e.n}</h2>
        <div class="d-id-row"><code class="d-id">${m._e.i}</code><button class="icon-btn" id="cid">${COPY_SVG}</button></div>
        <div class="d-badges">
          ${b(m.reasoning, "b-green", "Reasoning")}${b(m.tool_call, "b-green", "Tools")}${b(m.structured_output, "b-green", "Structured")}
          ${b(m.attachment, "b-dim", "Attachments")}${b(m.open_weights, "b-orange", "Open Weights")}
          ${b(m.status === "deprecated", "b-red", "Deprecated")}${b(m.status === "beta", "b-orange", "Beta")}${b(m.status === "alpha", "b-red", "Alpha")}
        </div>
      </div>
      <div class="d-body">
        <div class="d-card"><h3>Pricing <span class="dim">per 1M tokens</span></h3><table>${costs.map(([l, v]) => kv(l, v)).join("")}</table></div>
        <div class="d-card"><h3>Limits</h3><table>${kv("Context", fmt(m.limit?.context))}${kv("Max Input", fmt(m.limit?.input))}${kv("Max Output", fmt(m.limit?.output))}</table></div>
        <div class="d-card"><h3>Modalities</h3><table>${kv("Input", m.modalities?.input?.join(", ") ?? "—")}${kv("Output", m.modalities?.output?.join(", ") ?? "—")}</table></div>
        <div class="d-card"><h3>Info</h3><table>${kv("Family", m.family ?? "—")}${kv("Knowledge", m.knowledge ?? "—")}${kv("Released", m.release_date ?? "—")}${kv("Updated", m.last_updated ?? "—")}</table></div>
      </div>
      <div class="dialog-footer"><button class="copy-all" id="ca">${COPY_SVG} Copy all</button></div>`;
    copyBtn.call(this, "#cid", m.id);
    copyBtn.call(this, "#ca", () => modelText(m));
    showDialog(this, "cd");
  }
}

customElements.define("model-detail", ModelDetail);

function modelText(m) {
  const p = S.providers[m.pid];
  const caps = [m.reasoning && "Reasoning", m.tool_call && "Tools", m.structured_output && "Structured Output", m.open_weights && "Open Weights"].filter(Boolean);
  return [
    m.name, `${p?.name ?? m.pid} · ${m.id}`, "", ...(caps.length ? [caps.join(", "), ""] : []),
    "Pricing (per 1M tokens)", `  Input:       ${cost(m.cost?.input)}`, `  Output:      ${cost(m.cost?.output)}`,
    ...(m.cost?.reasoning != null ? [`  Reasoning:   ${cost(m.cost.reasoning)}`] : []),
    ...(m.cost?.cache_read != null ? [`  Cache Read:  ${cost(m.cost.cache_read)}`] : []),
    ...(m.cost?.cache_write != null ? [`  Cache Write: ${cost(m.cost.cache_write)}`] : []),
    "", "Limits", `  Context:     ${fmt(m.limit?.context)}`, `  Max Input:   ${fmt(m.limit?.input)}`, `  Max Output:  ${fmt(m.limit?.output)}`,
    "", "Modalities", `  Input:       ${m.modalities?.input?.join(", ") ?? "—"}`, `  Output:      ${m.modalities?.output?.join(", ") ?? "—"}`,
    "", "Info", `  Family:      ${m.family ?? "—"}`, `  Knowledge:   ${m.knowledge ?? "—"}`, `  Released:    ${m.release_date ?? "—"}`,
  ].join("\n");
}

// ── Compare ──────────────────────────────────────────────────

const CMP = [
  ["Provider",         (m) => m.provider],
  ["Model ID",         (m) => m.id,                      null, null, "id"],
  ["Family",           (m) => m.family ?? "—"],
  ["Input /M",         (m) => cost(m.cost?.input),     (m) => m.cost?.input,     "lower"],
  ["Output /M",        (m) => cost(m.cost?.output),    (m) => m.cost?.output,    "lower"],
  ["Reasoning /M",     (m) => cost(m.cost?.reasoning), (m) => m.cost?.reasoning, "lower"],
  ["Context",          (m) => fmt(m.limit?.context),   (m) => m.limit?.context,  "higher"],
  ["Max Input",        (m) => fmt(m.limit?.input),     (m) => m.limit?.input,    "higher"],
  ["Max Output",       (m) => fmt(m.limit?.output),    (m) => m.limit?.output,   "higher"],
  ["Reasoning",        (m) => yn(m.reasoning)],  ["Tools", (m) => yn(m.tool_call)],
  ["Structured",       (m) => yn(m.structured_output)],
  ["Open Weights",     (m) => m.open_weights ? "Open" : "Closed"],
  ["Input Modalities", (m) => m.modalities?.input?.join(", ") ?? "—"],
  ["Knowledge",        (m) => m.knowledge ?? "—"],  ["Released", (m) => m.release_date ?? "—"],
];

class ModelCompare extends HTMLElement {
  connectedCallback() { on("open-compare", () => this.show()); }

  show() {
    const ms = S.all.filter((m) => S.compare.has(m._key));
    if (ms.length < 2) return;

    const trs = CMP.map(([label, fn, valFn, dir, type]) => {
      const best = valFn && dir ? bestIndexes(ms.map(valFn), dir) : new Set();
      const tds = ms.map((m, i) => {
        const c = best.has(i) ? ' class="best"' : "", t = esc(String(fn(m)));
        return type === "id" ? `<td${c}><span class="cmp-id">${t} <button class="icon-btn sm cmp-copy" data-mid="${esc(m.id)}">${COPY_SVG}</button></span></td>` : `<td${c}>${t}</td>`;
      }).join("");
      return `<tr><td>${esc(label)}</td>${tds}</tr>`;
    }).join("");

    this.innerHTML = `
      <button class="dialog-close" id="cc">✕</button><h2>Compare models</h2>
      <table><thead><tr><th></th>${ms.map((m) => `<th><div class="col-head">${m._e.n}<small>${m._e.p}</small></div></th>`).join("")}</tr></thead><tbody>${trs}</tbody></table>
      <div class="dialog-footer"><button class="copy-all" id="cca">${COPY_SVG} Copy all</button></div>`;
    this.querySelectorAll(".cmp-copy").forEach((b) => copyBtn.call(this, b, b.dataset.mid));
    copyBtn.call(this, "#cca", () => cmpText(ms));
    showDialog(this, "cc");
  }
}

customElements.define("model-compare", ModelCompare);

function cmpText(ms) {
  const ml = Math.max(...CMP.map(([l]) => l.length)), mn = Math.max(...ms.map((m) => m.name.length));
  const p = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  return ["Compare models", "", p("", ml + 2) + ms.map((m) => p(m.name, mn + 2)).join(""), "",
    ...CMP.map(([l, fn]) => p(l, ml + 2) + ms.map((m) => p(String(fn(m)), mn + 2)).join(""))].join("\n");
}

// ── Search / Shortcuts / Compare / Theme ─────────────────────

const $s = document.getElementById("search");
$s.oninput = () => {
  const q = $s.value.trim().toLowerCase();
  if (!q) { S.filtered = S.all; } else {
    const terms = q.split(/\s+/);
    S.filtered = S.all.filter((_, i) => { const h = S.index[i]; for (const t of terms) if (h.indexOf(t) === -1) return false; return true; });
  }
  emit("filtered");
};

document.onkeydown = (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "k") { e.preventDefault(); $s.focus(); $s.select(); }
  if (e.key === "e") { e.preventDefault(); if (S.compare.size >= 2) emit("open-compare"); }
};

const $c = document.getElementById("compare-btn"), $cn = document.getElementById("compare-count");
on("compare-changed", () => { $cn.textContent = S.compare.size; $c.disabled = S.compare.size < 2; });
$c.onclick = () => { if (S.compare.size >= 2) emit("open-compare"); };

const $t = document.getElementById("theme-toggle");
const theme = (t) => { document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); $t.textContent = t === "dark" ? "☀" : "◑"; };
$t.onclick = () => theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
theme(localStorage.getItem("theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

load().then(() => emit("loaded")).catch((e) => { document.querySelector("model-table").innerHTML = `<div class="empty">Failed: ${e.message}</div>`; });
