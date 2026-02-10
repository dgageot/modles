const API = "https://models.dev/api.json";
const LOGO = (id) => `https://models.dev/logos/${id}.svg`;
const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ROW_H = 34, OVERSCAN = 8;

// ── Helpers ──────────────────────────────────────────────────

const ESC_RE = /[&<>"']/g;
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s = "") => String(s ?? "").replace(ESC_RE, (c) => ESC_MAP[c]);
const dash = (v, f) => v == null ? "—" : f(v);
const fmt = (n) => dash(n, (v) => v.toLocaleString("en-US"));
const cost = (n) => dash(n, (v) => `$${v.toFixed(2)}`);
const yn = (v) => v ? "✓" : "—";

function flashCopy(btn, text, label) {
  const orig = btn.innerHTML;
  navigator.clipboard.writeText(text);
  btn.innerHTML = label ? `${CHECK_SVG} ${label}` : CHECK_SVG;
  btn.classList.add("copied");
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove("copied"); }, 1500);
}

function setupCopy(root, sel, text) {
  const btn = typeof sel === "string" ? root.querySelector(sel) : sel;
  const isLazy = typeof text === "function";
  btn.onclick = (e) => { e.stopPropagation(); flashCopy(btn, isLazy ? text() : text, isLazy ? "Copied!" : null); };
}

function showDialog(el, closeId) {
  const dlg = el.closest("dialog");
  dlg.showModal();
  el.querySelector(`#${closeId}`).onclick = () => dlg.close();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  return dlg;
}

// ── State ────────────────────────────────────────────────────

const S = {
  providers: {},
  all: [],
  filtered: [],
  sort: { col: "provider", dir: 1 },
  compare: new Set(),
};

const bus = new EventTarget();
const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));
const on = (n, fn) => bus.addEventListener(n, (e) => fn(e.detail));

// ── Columns ──────────────────────────────────────────────────

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

  S.providerNames = new Map();
  for (const [pid, p] of Object.entries(S.providers)) {
    S.providerNames.set(pid.toLowerCase(), pid);
    S.providerNames.set(p.name.toLowerCase(), pid);
  }

  for (const m of S.all) {
    m._key = `${m.pid}/${m.id}`;
    m._html = { p: esc(m.provider), n: esc(m.name), i: esc(m.id), f: esc(m.family ?? "—") };
    m._search = `${m.provider}\t${m.pid}\t${m.name}\t${m.id}\t${m.family}`.toLowerCase();
  }
  S.filtered = S.all;
}

// ── Table ────────────────────────────────────────────────────

class ModelTable extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `<div class="loading"><div class="spinner"></div><div>Loading…</div></div>`;
    on("loaded", () => this.init());
    on("sorted", () => this.refresh());
    on("filtered", () => { this.counts(); this.scrollTop = 0; this.refresh(); });
    on("compare-changed", ({ key }) => this.toggleRow(key));
  }

  init() {
    this.sort();
    this.innerHTML = `<table><thead><tr>${this.thead()}</tr></thead><tbody></tbody></table>`;
    this.tb = this.querySelector("tbody");
    this.modelsByKey = new Map(S.all.map((m) => [m._key, m]));
    this.counts();
    this._w = [-1, -1]; this._raf = 0;
    this.addEventListener("scroll", () => { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); });
    this.listen();
    this.draw();
    this.setColumnWidths();
  }

  refresh() { this.sort(); this.querySelector("thead tr").innerHTML = this.thead(); this._w = [-1, -1]; this.draw(); }

  toggleRow(key) {
    const row = this.tb.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
    if (row) row.classList.toggle("selected", S.compare.has(key));
  }

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
    const k = m._key, sel = S.compare.has(k), h = m._html;
    return `<tr data-key="${k}" class="${sel ? "selected" : ""}${m.status === "deprecated" ? " status-deprecated" : ""}">` +
      `<td class="cmp-cell"><label><input type="checkbox" class="compare-cb" data-key="${k}"${sel ? " checked" : ""}></label></td>` +
      `<td>${h.p}</td><td><a class="model-link" data-key="${k}">${h.n}</a></td>` +
      `<td class="mono dim id-cell"><span class="id-wrap"><a class="model-link" data-key="${k}">${h.i}</a><button class="icon-btn sm copy-id" data-id="${h.i}">${COPY_SVG}</button></span></td><td>${h.f}</td>` +
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

  setColumnWidths() {
    const CH = 7.5, CH_MONO = 7.2, PAD = 28;
    const mobile = matchMedia("(max-width: 700px)").matches;
    let pLen = 8, nLen = 5, iLen = 8, fLen = 6;
    for (const m of S.all) {
      pLen = Math.max(pLen, m.provider.length);
      nLen = Math.max(nLen, m.name.length);
      iLen = Math.max(iLen, m.id.length);
      fLen = Math.max(fLen, (m.family ?? "").length);
    }
    const w = [
      34,
      Math.min(pLen * CH + PAD, mobile ? 110 : 200),
      Math.min(nLen * CH + PAD, mobile ? 180 : 280),
      Math.min(iLen * CH_MONO + PAD + 30, mobile ? 200 : 350),
      Math.min(fLen * CH + PAD, mobile ? 100 : 160),
      90, 90, 100, 90, 85, 65, 65, 75,
    ];
    const cg = document.createElement("colgroup");
    w.forEach((v) => { const c = document.createElement("col"); c.style.width = `${v}px`; cg.appendChild(c); });
    const t = this.querySelector("table"); t.style.tableLayout = "fixed"; t.prepend(cg);
  }

  counts() {
    const countName = document.getElementById("count-name");
    const countProvider = document.getElementById("count-provider");
    if (countName) countName.textContent = `(${S.filtered.length})`;
    if (countProvider) countProvider.textContent = `(${new Set(S.filtered.map((m) => m.pid)).size})`;
  }

  listen() {
    this.querySelector("thead").onclick = (e) => {
      const th = e.target.closest("th[data-col]"); if (!th) return;
      S.sort.dir = S.sort.col === th.dataset.col ? S.sort.dir * -1 : 1;
      S.sort.col = th.dataset.col;
      emit("sorted");
    };
    this.tb.onclick = (e) => {
      if (e.target.closest(".cmp-cell")) { e.stopPropagation(); return; }
      const cp = e.target.closest(".copy-id");
      if (cp) { e.stopPropagation(); flashCopy(cp, cp.dataset.id); return; }
      const a = e.target.closest(".model-link");
      if (a) { e.preventDefault(); const m = this.modelsByKey.get(a.dataset.key); if (m) emit("open-detail", m); }
    };
    this.tb.addEventListener("change", (e) => {
      const cb = e.target.closest(".compare-cb");
      if (!cb) return;
      toggleCompare(cb.dataset.key, cb);
      emit("compare-changed", { key: cb.dataset.key });
    });
  }

  sort() {
    const col = COLS.find((c) => c.id === S.sort.col);
    if (!col?.get) return;
    const dir = S.sort.dir, get = col.get;
    S.all.sort((a, b) => {
      let va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      if (typeof va === "boolean") { va = +va; vb = +vb; }
      return typeof va === "string" ? (va < vb ? -dir : va > vb ? dir : 0) : (va - vb) * dir;
    });
    if (S.filtered.length < S.all.length) {
      const keys = new Set(S.filtered.map((m) => m._key));
      S.filtered = S.all.filter((m) => keys.has(m._key));
    } else {
      S.filtered = S.all;
    }
  }
}

customElements.define("model-table", ModelTable);

function toggleCompare(key, cb) {
  if (S.compare.has(key)) { S.compare.delete(key); return; }
  if (S.compare.size >= 4) { cb.checked = false; return; }
  S.compare.add(key);
}

// ── Detail ───────────────────────────────────────────────────

class ModelDetail extends HTMLElement {
  connectedCallback() { on("open-detail", (m) => this.show(m)); }

  show(m) {
    const p = S.providers[m.pid];
    const badge = (c, cls, t) => c ? `<span class="badge ${cls}">${t}</span>` : "";
    const kv = (l, v) => `<tr><td class="kl">${esc(l)}</td><td class="kv">${esc(String(v))}</td></tr>`;

    const costs = [
      ["Input", cost(m.cost?.input)],
      ["Output", cost(m.cost?.output)],
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
        <h2 class="d-name">${m._html.n}</h2>
        <div class="d-id-row"><code class="d-id">${m._html.i}</code><button class="icon-btn" id="cid">${COPY_SVG}</button></div>
        <div class="d-badges">
          ${badge(m.reasoning, "b-green", "Reasoning")}${badge(m.tool_call, "b-green", "Tools")}${badge(m.structured_output, "b-green", "Structured")}
          ${badge(m.attachment, "b-dim", "Attachments")}${badge(m.open_weights, "b-orange", "Open Weights")}
          ${badge(m.status === "deprecated", "b-red", "Deprecated")}${badge(m.status === "beta", "b-orange", "Beta")}${badge(m.status === "alpha", "b-red", "Alpha")}
        </div>
      </div>
      <div class="d-body">
        <div class="d-card"><h3>Pricing <span class="dim">per 1M tokens</span></h3><table>${costs.map(([l, v]) => kv(l, v)).join("")}</table></div>
        <div class="d-card"><h3>Limits</h3><table>${kv("Context", fmt(m.limit?.context))}${kv("Max Input", fmt(m.limit?.input))}${kv("Max Output", fmt(m.limit?.output))}</table></div>
        <div class="d-card"><h3>Modalities</h3><table>${kv("Input", m.modalities?.input?.join(", ") ?? "—")}${kv("Output", m.modalities?.output?.join(", ") ?? "—")}</table></div>
        <div class="d-card"><h3>Info</h3><table>${kv("Family", m.family ?? "—")}${kv("Knowledge", m.knowledge ?? "—")}${kv("Released", m.release_date ?? "—")}${kv("Updated", m.last_updated ?? "—")}</table></div>
      </div>
      <div class="dialog-footer"><button class="copy-all" id="ca">${COPY_SVG} Copy all</button></div>`;
    setupCopy(this, "#cid", m.id);
    setupCopy(this, "#ca", () => modelText(m));
    history.replaceState(null, "", `#${m._key}`);
    const dlg = showDialog(this, "cd");
    dlg.addEventListener("close", () => {
      if (location.hash === `#${m._key}`) history.replaceState(null, "", location.pathname + location.search);
    }, { once: true });
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

const CMP_ROWS = [
  { label: "Provider",         fn: (m) => m.provider },
  { label: "Model ID",         fn: (m) => m.id, type: "id" },
  { label: "Family",           fn: (m) => m.family ?? "—" },
  { label: "Input /M",         fn: (m) => cost(m.cost?.input),     val: (m) => m.cost?.input,     best: "lower" },
  { label: "Output /M",        fn: (m) => cost(m.cost?.output),    val: (m) => m.cost?.output,    best: "lower" },
  { label: "Reasoning /M",     fn: (m) => cost(m.cost?.reasoning), val: (m) => m.cost?.reasoning, best: "lower" },
  { label: "Context",          fn: (m) => fmt(m.limit?.context),   val: (m) => m.limit?.context,  best: "higher" },
  { label: "Max Input",        fn: (m) => fmt(m.limit?.input),     val: (m) => m.limit?.input,    best: "higher" },
  { label: "Max Output",       fn: (m) => fmt(m.limit?.output),    val: (m) => m.limit?.output,   best: "higher" },
  { label: "Reasoning",        fn: (m) => yn(m.reasoning) },
  { label: "Tools",            fn: (m) => yn(m.tool_call) },
  { label: "Structured",       fn: (m) => yn(m.structured_output) },
  { label: "Open Weights",     fn: (m) => m.open_weights ? "Open" : "Closed" },
  { label: "Input Modalities", fn: (m) => m.modalities?.input?.join(", ") ?? "—" },
  { label: "Knowledge",        fn: (m) => m.knowledge ?? "—" },
  { label: "Released",         fn: (m) => m.release_date ?? "—" },
];

function bestIndexes(values, dir) {
  const ok = values.filter((v) => v != null);
  if (!ok.length) return new Set();
  const target = dir === "lower" ? Math.min(...ok) : Math.max(...ok);
  return new Set(values.flatMap((v, i) => v === target ? [i] : []));
}

class ModelCompare extends HTMLElement {
  connectedCallback() { on("open-compare", (keys) => this.show(keys)); }

  show(keys) {
    if (keys) {
      S.compare.clear();
      keys.forEach((k) => S.compare.add(k));
      emit("compare-changed", {});
    }
    const ms = S.all.filter((m) => S.compare.has(m._key));
    if (ms.length < 2) return;

    const compareHash = `#compare:${ms.map((m) => m._key).join(",")}`;

    const trs = CMP_ROWS.map((r) => {
      const best = r.val && r.best ? bestIndexes(ms.map(r.val), r.best) : new Set();
      const tds = ms.map((m, i) => {
        const cls = best.has(i) ? ' class="best"' : "", text = esc(String(r.fn(m)));
        return r.type === "id"
          ? `<td${cls}><span class="cmp-id">${text} <button class="icon-btn sm cmp-copy" data-mid="${esc(m.id)}">${COPY_SVG}</button></span></td>`
          : `<td${cls}>${text}</td>`;
      }).join("");
      return `<tr><td>${esc(r.label)}</td>${tds}</tr>`;
    }).join("");

    this.innerHTML = `
      <button class="dialog-close" id="cc">✕</button><h2>Compare models</h2>
      <table><thead><tr><th></th>${ms.map((m) => `<th><div class="col-head">${m._html.n}<small>${m._html.p}</small></div></th>`).join("")}</tr></thead><tbody>${trs}</tbody></table>
      <div class="dialog-footer"><button class="copy-all" id="cca">${COPY_SVG} Copy</button></div>`;
    this.querySelectorAll(".cmp-copy").forEach((b) => setupCopy(this, b, b.dataset.mid));
    setupCopy(this, "#cca", () => cmpText(ms));
    history.replaceState(null, "", compareHash);
    const dlg = showDialog(this, "cc");
    dlg.addEventListener("close", () => {
      if (location.hash === compareHash) history.replaceState(null, "", location.pathname + location.search);
    }, { once: true });
  }
}

customElements.define("model-compare", ModelCompare);

function cmpText(ms) {
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  const cols = ["", ...ms.map((m) => m.name)];
  const rows = CMP_ROWS.map((r) => [r.label, ...ms.map((m) => String(r.fn(m)))]);
  const all = [cols, ...rows];
  const widths = cols.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => "| " + r.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  return [line(cols), sep, ...rows.map(line)].join("\n");
}

// ── Search / Shortcuts / Compare / Theme ─────────────────────

const $s = document.getElementById("search");
const $box = document.getElementById("search-box");
const $dd = document.getElementById("search-dropdown");
const pills = [];       // [{ type: "provider"|"family", value, pid? }]
let ddItems = [];       // current dropdown items
let ddIdx = -1;         // highlighted index
let suggestions = [];   // built after load

function buildSuggestions() {
  const provs = [], fams = new Set();
  for (const [pid, p] of Object.entries(S.providers)) provs.push({ type: "provider", label: p.name, pid });
  for (const m of S.all) if (m.family) fams.add(m.family);
  suggestions = [
    ...provs.sort((a, b) => a.label.localeCompare(b.label)).map((p) => ({ ...p, search: p.label.toLowerCase() })),
    ...[...fams].sort().map((f) => ({ type: "family", label: f, search: f.toLowerCase() })),
  ];
}

function matchSuggestions(q) {
  if (!q) return suggestions.slice(0, 12);
  const lq = q.toLowerCase();
  const used = new Set(pills.map((p) => `${p.type}:${p.value}`));
  return suggestions.filter((s) => s.search.includes(lq) && !used.has(`${s.type}:${s.label}`)).slice(0, 8);
}

function renderDropdown() {
  const q = $s.value.trim();
  ddItems = matchSuggestions(q);
  ddIdx = -1;
  if (!ddItems.length) { $dd.hidden = true; return; }
  $dd.innerHTML = ddItems.map((s, i) =>
    `<li data-idx="${i}"><span class="dd-type ${s.type}">${s.type}</span> ${esc(s.label)}</li>`
  ).join("");
  $dd.hidden = false;
}

function highlightDD(idx) {
  ddIdx = idx;
  $dd.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === idx));
}

function selectSuggestion(s) {
  pills.push({ type: s.type, value: s.label, pid: s.pid });
  renderPills();
  $s.value = "";
  $dd.hidden = true;
  applyFilter();
  $s.focus();
}

function removePill(idx) {
  pills.splice(idx, 1);
  renderPills();
  applyFilter();
  $s.focus();
}

function renderPills() {
  $box.querySelectorAll(".pill").forEach((el) => el.remove());
  pills.forEach((p, i) => {
    const el = document.createElement("span");
    el.className = `pill pill-${p.type}`;
    el.innerHTML = `${esc(p.value)} <button data-idx="${i}">&times;</button>`;
    el.querySelector("button").onclick = (e) => { e.stopPropagation(); removePill(i); };
    $box.insertBefore(el, $s);
  });
  $s.placeholder = pills.length ? "" : "Search models\u2026";
}

function applyFilter() {
  const provPids = new Set();
  const famFilters = new Set();
  for (const p of pills) {
    if (p.type === "provider") provPids.add(p.pid);
    if (p.type === "family") famFilters.add(p.value.toLowerCase());
  }
  const q = $s.value.trim().toLowerCase();
  const textTerms = q ? q.split(/\s+/) : [];

  if (!provPids.size && !famFilters.size && !textTerms.length) {
    S.filtered = S.all;
  } else {
    S.filtered = S.all.filter((m) => {
      if (provPids.size && !provPids.has(m.pid)) return false;
      if (famFilters.size && !famFilters.has((m.family ?? "").toLowerCase())) return false;
      return textTerms.every((t) => m._search.includes(t));
    });
  }
  emit("filtered");
}

if (window.innerWidth > 700) {
  $s.placeholder = "Search models\u2026";
} else {
  $s.removeAttribute("autofocus");
  $s.blur();
}

$s.oninput = () => { renderDropdown(); applyFilter(); };

$s.onkeydown = (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); if (!$dd.hidden) highlightDD(Math.min(ddIdx + 1, ddItems.length - 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); if (!$dd.hidden) highlightDD(Math.max(ddIdx - 1, 0)); }
  else if (e.key === "Enter") { e.preventDefault(); if (ddIdx >= 0 && ddItems[ddIdx]) selectSuggestion(ddItems[ddIdx]); }
  else if (e.key === "Tab") { e.preventDefault(); renderDropdown(); if (ddItems.length) selectSuggestion(ddItems[0]); }
  else if (e.key === "Escape") { $dd.hidden = true; }
  else if (e.key === "Backspace" && !$s.value && pills.length) { removePill(pills.length - 1); }
};

$s.onfocus = () => renderDropdown();

$dd.onmousedown = (e) => {
  e.preventDefault();
  const li = e.target.closest("li");
  if (li) selectSuggestion(ddItems[+li.dataset.idx]);
};

$box.onclick = () => $s.focus();

document.addEventListener("click", (e) => { if (!$box.contains(e.target) && !$dd.contains(e.target)) $dd.hidden = true; });

document.onkeydown = (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "k") { e.preventDefault(); $s.focus(); $s.select(); renderDropdown(); }
  if (e.key === "e") { e.preventDefault(); if (S.compare.size >= 2) emit("open-compare"); }
};

const $c = document.getElementById("compare-btn"), $cn = document.getElementById("compare-count");
on("compare-changed", () => { $cn.textContent = S.compare.size; $c.disabled = S.compare.size < 2; });
$c.onclick = () => { if (S.compare.size >= 2) emit("open-compare"); };

const $t = document.getElementById("theme-toggle");
const theme = (t) => { document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); $t.textContent = t === "dark" ? "☀" : "◑"; };
$t.onclick = () => theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
theme(localStorage.getItem("theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));

load().then(() => { emit("loaded"); buildSuggestions(); openFromHash(); }).catch((e) => { document.querySelector("model-table").innerHTML = `<div class="empty">Failed: ${e.message}</div>`; });

// ── Hash routing ─────────────────────────────────────────────

const COMPARE_PREFIX = "compare:";

function openFromHash() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) return;
  if (hash.startsWith(COMPARE_PREFIX)) {
    const keys = hash.slice(COMPARE_PREFIX.length).split(",").filter(Boolean);
    if (keys.length >= 2) emit("open-compare", keys);
    return;
  }
  const m = S.all.find((m) => m._key === hash);
  if (m) emit("open-detail", m);
}

window.addEventListener("hashchange", () => {
  if (location.hash) openFromHash();
  else { document.getElementById("detail-dialog")?.close(); document.getElementById("compare-dialog")?.close(); }
});
