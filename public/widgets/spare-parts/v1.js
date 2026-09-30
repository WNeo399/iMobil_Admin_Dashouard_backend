/*!
 * iMobile Spare Parts widget — v1
 *
 * Embed:
 *   <div id="imobile-spare-parts"></div>
 *   <script src="https://<backend>/widget-assets/spare-parts/v1.js" defer></script>
 *
 * Optional data attributes on the mount div:
 *   data-api-base="https://<backend>"   where the parts come from (default: the
 *                                       server this script was loaded from)
 *   data-title="Find parts for your device"   heading; data-title="" hides it
 *   data-accent="#0b7fd4"               colour of the selected tabs and links
 *   data-new-tab="true"                 open a part in a new tab (default: same tab)
 *   data-product-base="https://…/products/"   where a part links to, before its
 *                                       Zoho item id (default: the iMobile store)
 *   data-brand / data-series / data-model   open straight on a brand or model,
 *                                       e.g. data-brand="Apple" data-model="iPhone 13"
 *
 * Browse Brand → Series → Model → part type, or search by part, SKU or model.
 * No prices; each part links to its page on the store. The data is the
 * dashboard's stock register (live spare parts shown in the online store),
 * so nothing is managed here. Layout follows the CONTAINER's width, so it
 * also suits a narrow column. Hand-written vanilla JS, no build step, in a
 * Shadow DOM so host page CSS can't leak in.
 * Data: GET /widget/spareParts/catalog | /parts | /search
 */
(function () {
  "use strict";

  var MOUNT_ID = "imobile-spare-parts";
  var IMG_BASE = "https://www.imobilestore.com.au/product-images/image/";
  var PAGE = 36; // cards before "Show more"
  var SCRIPT = document.currentScript;

  var CSS = [
    ":host{all:initial;display:block}",
    "*{box-sizing:border-box}",
    ".root{--accent:#0b7fd4;--text:#1f2937;--muted:#6b7280;--line:#e5e7eb;--soft:#f3f4f6;",
    "  font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.45;",
    "  color:var(--text);background:#fff;-webkit-tap-highlight-color:transparent}",
    "button{font:inherit;color:inherit}",
    ".head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}",
    ".title{font-size:20px;font-weight:700;margin:0;flex:1 1 auto}",
    ".search{position:relative;flex:0 1 340px;min-width:200px}",
    ".search input{width:100%;height:40px;border:1px solid var(--line);border-radius:10px;padding:0 36px 0 38px;",
    "  font:inherit;color:inherit;background:#fff;outline:none}",
    ".search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(11,127,212,.15)}",
    ".search .ico{position:absolute;left:12px;top:11px;width:18px;height:18px;color:var(--muted)}",
    ".search .clear{position:absolute;right:6px;top:6px;width:28px;height:28px;border:0;background:none;",
    "  border-radius:6px;cursor:pointer;color:var(--muted);display:none}",
    ".search.has .clear{display:block}",
    ".crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px;color:var(--muted);margin-bottom:12px;min-height:20px}",
    ".crumbs button{border:0;background:none;padding:0;color:var(--accent);cursor:pointer}",
    ".crumbs button:hover{text-decoration:underline}",
    ".crumbs .sep{opacity:.6}",
    ".crumbs .here{color:var(--text);font-weight:600}",
    ".grid{display:grid;gap:10px}",
    ".tiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}",
    ".tile{border:1px solid var(--line);border-radius:12px;background:#fff;padding:16px 14px;text-align:left;cursor:pointer;",
    "  transition:border-color .15s,box-shadow .15s}",
    ".tile:hover{border-color:var(--accent);box-shadow:0 2px 10px rgba(0,0,0,.06)}",
    ".tile .n{font-weight:700;font-size:15px}",
    ".tile .c{font-size:12px;color:var(--muted);margin-top:2px}",
    ".chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}",
    ".chip{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 12px;cursor:pointer;font-size:13px;white-space:nowrap}",
    ".chip:hover{border-color:var(--accent)}",
    ".chip[aria-pressed='true']{background:var(--accent);border-color:var(--accent);color:#fff}",
    ".chip .k{opacity:.7;margin-left:4px;font-size:12px}",
    ".chips.small .chip{padding:4px 10px;font-size:12px}",
    ".bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}",
    ".filter{height:34px;border:1px solid var(--line);border-radius:8px;padding:0 10px;font:inherit;color:inherit;outline:none;width:220px;max-width:100%}",
    ".filter:focus{border-color:var(--accent)}",
    ".models{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}",
    ".model{border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px 12px;text-align:left;cursor:pointer}",
    ".model:hover{border-color:var(--accent)}",
    ".model .n{font-weight:600}",
    ".model .c{font-size:12px;color:var(--muted)}",
    ".cards{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}",
    ".card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;",
    "  text-decoration:none;color:inherit;transition:border-color .15s,box-shadow .15s}",
    ".card:hover{border-color:var(--accent);box-shadow:0 4px 14px rgba(0,0,0,.08)}",
    ".card:focus-visible,.tile:focus-visible,.model:focus-visible,.chip:focus-visible,.more:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".pic{aspect-ratio:1/1;background:var(--soft);display:flex;align-items:center;justify-content:center}",
    ".pic img{width:100%;height:100%;object-fit:contain;display:block;background:#fff}",
    ".pic svg{width:42px;height:42px;color:#c4c9d1}",
    ".info{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1}",
    ".name{font-size:13px;font-weight:600;overflow-wrap:anywhere}",
    ".meta{margin-top:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--muted)}",
    ".tag{background:var(--soft);border-radius:4px;padding:1px 6px;color:var(--text)}",
    ".view{margin-left:auto;color:var(--accent);font-weight:600;white-space:nowrap}",
    ".section{font-size:13px;font-weight:600;color:var(--muted);margin:14px 0 8px}",
    ".count{font-size:13px;color:var(--muted)}",
    ".more{display:block;margin:14px auto 0;border:1px solid var(--line);background:#fff;border-radius:999px;padding:8px 20px;cursor:pointer}",
    ".more:hover{border-color:var(--accent);color:var(--accent)}",
    ".msg{padding:40px 16px;text-align:center;color:var(--muted)}",
    ".msg button{margin-top:10px;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer}",
    ".spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;",
    "  margin:0 auto 10px;animation:sp .8s linear infinite}",
    "@keyframes sp{to{transform:rotate(360deg)}}",
    ".root.sm .title{font-size:17px}",
    ".root.sm .search{flex:1 1 100%}",
    ".root.sm .tiles{grid-template-columns:repeat(2,minmax(0,1fr))}",
    ".root.sm .models{grid-template-columns:repeat(2,minmax(0,1fr))}",
    ".root.sm .cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
    ".root.sm .chips.scroll{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}",
    ".root.sm .chips.scroll::-webkit-scrollbar{display:none}",
    ".root.sm .filter{width:100%}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    "@media (prefers-reduced-motion:reduce){.spin{animation:none}}",
  ].join("\n");

  var ICON_SEARCH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  var ICON_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/></svg>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }
  function scriptOrigin() {
    try {
      return new URL(SCRIPT && SCRIPT.src ? SCRIPT.src : location.href).origin;
    } catch (e) {
      return location.origin;
    }
  }
  function same(a, b) {
    return String(a || "").toLowerCase() === String(b || "").toLowerCase();
  }

  function init(mount) {
    if (mount.shadowRoot) return;
    var apiBase = (mount.getAttribute("data-api-base") || scriptOrigin()).replace(/\/+$/, "");
    var titleAttr = mount.getAttribute("data-title");
    var title = titleAttr == null ? "Find parts for your device" : titleAttr;
    var newTab = mount.getAttribute("data-new-tab") === "true";
    var productBase = mount.getAttribute("data-product-base") || "";
    var accent = mount.getAttribute("data-accent");

    var shadow = mount.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" + CSS + "</style>" +
      '<div class="root">' +
      '<div class="head">' +
      (title ? '<h2 class="title">' + esc(title) + "</h2>" : "") +
      '<label class="search">' + ICON_SEARCH +
      '<span class="sr">Search parts</span>' +
      '<input type="search" placeholder="Search part, SKU or model" autocomplete="off" enterkeyhint="search">' +
      '<button type="button" class="clear" aria-label="Clear search">&times;</button></label>' +
      "</div>" +
      '<nav class="crumbs" aria-label="Where you are"></nav>' +
      '<div class="body" aria-live="polite"></div>' +
      "</div>";
    var root = shadow.querySelector(".root");
    if (accent) root.style.setProperty("--accent", accent);
    var crumbsEl = shadow.querySelector(".crumbs");
    var body = shadow.querySelector(".body");
    var searchBox = shadow.querySelector(".search");
    var input = searchBox.querySelector("input");

    var catalog = null;
    var partsCache = {};
    var searchCache = {};
    var view = { kind: "brands" };
    var beforeSearch = null;
    var searchTimer = null;
    var seq = 0; // drops answers that arrive after the view moved on

    function api(path) {
      return fetch(apiBase + path, { credentials: "omit" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }).then(function (j) {
        if (!j || j.success === false) throw new Error((j && j.message) || "Failed");
        return j;
      });
    }
    function typeLabel(t) {
      return (catalog && catalog.typeLabels && catalog.typeLabels[t]) || t;
    }
    function link(id) {
      return (productBase || (catalog && catalog.productBase) || "https://www.imobilestore.com.au/products/") + encodeURIComponent(id);
    }
    function findBrand(name) {
      if (!catalog) return null;
      for (var i = 0; i < catalog.brands.length; i++) if (same(catalog.brands[i].name, name)) return catalog.brands[i];
      return null;
    }
    function seriesOf(brand, model) {
      for (var i = 0; i < brand.series.length; i++) {
        for (var j = 0; j < brand.series[i].models.length; j++) {
          if (same(brand.series[i].models[j].name, model)) return { series: brand.series[i], model: brand.series[i].models[j] };
        }
      }
      return null;
    }
    function hasSeries(brand) {
      return brand.series.length > 1 || !!brand.series[0].name;
    }

    // ── rendering ──
    function message(html, retry) {
      body.innerHTML = '<div class="msg">' + html + (retry ? '<br><button type="button" data-act="retry">Try again</button>' : "") + "</div>";
    }
    function loading() {
      body.innerHTML = '<div class="msg"><div class="spin"></div>Loading…</div>';
    }

    function renderCrumbs() {
      var parts = [];
      var btn = function (label, act, extra) {
        return '<button type="button" data-act="' + act + '"' + (extra || "") + ">" + esc(label) + "</button>";
      };
      var sep = '<span class="sep" aria-hidden="true">›</span>';
      var here = function (label) {
        return '<span class="here" aria-current="page">' + esc(label) + "</span>";
      };
      if (view.kind === "brands") parts.push(here("All brands"));
      else if (view.kind === "search") parts.push(btn("All brands", "home"), sep, here("Search results"));
      else if (view.kind === "tools") parts.push(btn("All brands", "home"), sep, here("Tools"));
      else {
        parts.push(btn("All brands", "home"), sep);
        var b = view.brand;
        if (view.kind === "brand") parts.push(here(b.name));
        else {
          parts.push(btn(b.name, "brand"), sep);
          if (hasSeries(b) && view.series) parts.push(btn(view.series.name, "series"), sep);
          parts.push(here(view.model.name));
        }
      }
      crumbsEl.innerHTML = parts.join("");
    }

    function renderBrands() {
      var html = '<div class="grid tiles">';
      catalog.brands.forEach(function (b, i) {
        html += '<button type="button" class="tile" data-act="open-brand" data-i="' + i + '"><div class="n">' + esc(b.name) +
          '</div><div class="c">' + plural(b.parts, "part") + "</div></button>";
      });
      if (catalog.tools) {
        html += '<button type="button" class="tile" data-act="open-tools"><div class="n">Tools</div><div class="c">' +
          plural(catalog.tools, "tool") + "</div></button>";
      }
      body.innerHTML = html + "</div>";
    }

    function modelButtons(models) {
      var f = (view.filter || "").toLowerCase().split(/\s+/).filter(Boolean);
      var list = models.filter(function (m) {
        var n = m.name.toLowerCase();
        return f.every(function (w) { return n.indexOf(w) >= 0; });
      });
      if (!list.length) return '<div class="msg">No model matches “' + esc(view.filter) + "”.</div>";
      return list.map(function (m) {
        return '<button type="button" class="model" data-act="open-model" data-model="' + esc(m.name) + '"><div class="n">' +
          esc(m.name) + '</div><div class="c">' + plural(m.parts, "part") + "</div></button>";
      }).join("");
    }

    function renderBrand() {
      var b = view.brand;
      var html = "";
      if (hasSeries(b)) {
        html += '<div class="chips scroll" role="group" aria-label="Series">';
        b.series.forEach(function (s, i) {
          html += '<button type="button" class="chip" data-act="pick-series" data-i="' + i + '" aria-pressed="' + (s === view.series) + '">' +
            esc(s.name) + '<span class="k">' + s.models.length + "</span></button>";
        });
        html += "</div>";
      }
      var models = (view.series || b.series[0]).models;
      html += '<div class="bar"><input class="filter" type="search" placeholder="Filter ' + plural(models.length, "model") +
        '" aria-label="Filter models" value="' + esc(view.filter || "") + '"><span class="count">Newest first</span></div>';
      html += '<div class="grid models">' + modelButtons(models) + "</div>";
      body.innerHTML = html;
    }

    function card(p) {
      var pic = p.imageId
        ? '<img loading="lazy" alt="" src="' + IMG_BASE + encodeURIComponent(p.imageId) + '/400x400">'
        : ICON_BOX;
      return '<a class="card" href="' + esc(link(p.id)) + '"' + (newTab ? ' target="_blank" rel="noopener"' : "") + ">" +
        '<div class="pic">' + pic + "</div>" +
        '<div class="info"><div class="name">' + esc(p.name) + "</div>" +
        '<div class="meta">' + (p.sku ? "<span>SKU " + esc(p.sku) + "</span>" : "") +
        (p.quality ? '<span class="tag">' + esc(p.quality) + "</span>" : "") +
        '<span class="view">View ›</span></div></div></a>';
    }

    // A model's (or the tools') parts: part-type tabs, then sub-type chips.
    function renderParts() {
      var items = view.items || [];
      if (!items.length) return message("No parts listed for this model yet.");
      var types = [];
      var byType = {};
      items.forEach(function (p) {
        if (!byType[p.type]) { byType[p.type] = []; types.push(p.type); }
        byType[p.type].push(p);
      });
      var html = "";
      if (types.length > 1) {
        html += '<div class="chips scroll" role="group" aria-label="Part type">' +
          '<button type="button" class="chip" data-act="pick-type" data-type="" aria-pressed="' + !view.type + '">All<span class="k">' + items.length + "</span></button>";
        types.forEach(function (t) {
          html += '<button type="button" class="chip" data-act="pick-type" data-type="' + esc(t) + '" aria-pressed="' + (view.type === t) + '">' +
            esc(typeLabel(t)) + '<span class="k">' + byType[t].length + "</span></button>";
        });
        html += "</div>";
      }
      var list = view.type ? byType[view.type] || [] : items;
      var subs = [];
      list.forEach(function (p) { if (p.sub && subs.indexOf(p.sub) < 0) subs.push(p.sub); });
      if (subs.length > 1) {
        html += '<div class="chips small scroll" role="group" aria-label="Kind">' +
          '<button type="button" class="chip" data-act="pick-sub" data-sub="" aria-pressed="' + !view.sub + '">Any</button>';
        subs.forEach(function (s) {
          html += '<button type="button" class="chip" data-act="pick-sub" data-sub="' + esc(s) + '" aria-pressed="' + (view.sub === s) + '">' + esc(s) + "</button>";
        });
        html += "</div>";
      }
      if (view.sub) list = list.filter(function (p) { return p.sub === view.sub; });
      var shown = view.shown || PAGE;
      html += '<div class="grid cards">' + list.slice(0, shown).map(card).join("") + "</div>";
      if (list.length > shown) {
        html += '<button type="button" class="more" data-act="more">Show more (' + (list.length - shown) + " more)</button>";
      }
      body.innerHTML = html;
    }

    function renderSearch() {
      var r = view.result;
      if (!r) return loading();
      if (!r.models.length && !r.items.length) return message("Nothing matches “" + esc(view.q) + "”. Try a model name like “iPhone 13” or a part like “battery”.");
      var html = "";
      if (r.models.length) {
        html += '<div class="section">Models</div><div class="chips">';
        r.models.forEach(function (m) {
          html += '<button type="button" class="chip" data-act="search-model" data-brand="' + esc(m.brand) + '" data-model="' + esc(m.name) + '">' +
            esc(m.name) + '<span class="k">' + m.parts + "</span></button>";
        });
        html += "</div>";
      }
      if (r.items.length) {
        html += '<div class="section">Parts <span class="count">' +
          (r.total > r.items.length ? "— first " + r.items.length + " of " + r.total + ", add a word to narrow it" : "— " + r.total) + "</span></div>";
        html += '<div class="grid cards">' + r.items.map(card).join("") + "</div>";
      }
      body.innerHTML = html;
    }

    function render() {
      renderCrumbs();
      if (!catalog) return;
      if (view.kind === "brands") renderBrands();
      else if (view.kind === "brand") renderBrand();
      else if (view.kind === "search") renderSearch();
      else if (view.items) renderParts();
      else loading();
    }

    // ── navigation ──
    function go(next, keepScroll) {
      view = next;
      render();
      if (!keepScroll) {
        var top = mount.getBoundingClientRect().top;
        if (top < 0) mount.scrollIntoView({ block: "start" });
      }
    }
    function openBrand(b, series) {
      go({ kind: "brand", brand: b, series: series || b.series[0], filter: "" });
    }
    function openModel(b, modelName) {
      var hit = seriesOf(b, modelName);
      if (!hit) return openBrand(b);
      var mine = ++seq;
      var key = b.name + "|" + hit.model.name;
      go({ kind: "model", brand: b, series: hit.series, model: hit.model, items: partsCache[key] || null, type: "", sub: "" });
      if (partsCache[key]) return;
      api("/widget/spareParts/parts?brand=" + encodeURIComponent(b.name) + "&model=" + encodeURIComponent(hit.model.name))
        .then(function (j) {
          partsCache[key] = j.items || [];
          if (mine === seq) { view.items = partsCache[key]; render(); }
        })
        .catch(function () { if (mine === seq) message("Couldn’t load the parts for this model.", true); });
    }
    function openTools() {
      var mine = ++seq;
      go({ kind: "tools", items: partsCache.tools || null, type: "", sub: "" });
      if (partsCache.tools) return;
      api("/widget/spareParts/parts?tools=1")
        .then(function (j) {
          partsCache.tools = j.items || [];
          if (mine === seq) { view.items = partsCache.tools; render(); }
        })
        .catch(function () { if (mine === seq) message("Couldn’t load the tools.", true); });
    }
    function runSearch(q) {
      if (view.kind !== "search") beforeSearch = view;
      var mine = ++seq;
      var key = q.toLowerCase();
      go({ kind: "search", q: q, result: searchCache[key] || null }, true);
      if (searchCache[key]) return;
      api("/widget/spareParts/search?q=" + encodeURIComponent(q))
        .then(function (j) {
          searchCache[key] = j;
          if (mine === seq) { view.result = j; render(); }
        })
        .catch(function () { if (mine === seq) message("Search isn’t available right now.", true); });
    }
    function endSearch() {
      ++seq;
      go(beforeSearch && beforeSearch.kind !== "search" ? beforeSearch : { kind: "brands" }, true);
      beforeSearch = null;
    }

    // ── events ──
    shadow.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!el || !shadow.contains(el)) return;
      var act = el.getAttribute("data-act");
      var clearSearch = function () { input.value = ""; searchBox.classList.remove("has"); beforeSearch = null; };
      if (act === "home") { clearSearch(); ++seq; go({ kind: "brands" }); }
      else if (act === "open-brand") openBrand(catalog.brands[+el.getAttribute("data-i")]);
      else if (act === "open-tools") openTools();
      else if (act === "brand") openBrand(view.brand);
      else if (act === "series") openBrand(view.brand, view.series);
      else if (act === "pick-series") { view.series = view.brand.series[+el.getAttribute("data-i")]; view.filter = ""; render(); }
      else if (act === "open-model") openModel(view.brand, el.getAttribute("data-model"));
      else if (act === "search-model") {
        var b = findBrand(el.getAttribute("data-brand"));
        clearSearch();
        if (b) openModel(b, el.getAttribute("data-model"));
      }
      else if (act === "pick-type") { view.type = el.getAttribute("data-type"); view.sub = ""; view.shown = PAGE; render(); }
      else if (act === "pick-sub") { view.sub = el.getAttribute("data-sub"); view.shown = PAGE; render(); }
      else if (act === "more") { view.shown = (view.shown || PAGE) + PAGE; render(); }
      else if (act === "retry") {
        // try the step that failed again
        if (!catalog) start();
        else if (view.kind === "model") openModel(view.brand, view.model.name);
        else if (view.kind === "tools") openTools();
        else if (view.kind === "search") runSearch(view.q);
        else render();
      }
    });
    // the model filter re-draws only the list, so typing keeps focus
    shadow.addEventListener("input", function (e) {
      if (!e.target.classList || !e.target.classList.contains("filter") || view.kind !== "brand") return;
      view.filter = e.target.value;
      var grid = body.querySelector(".models");
      if (grid) grid.innerHTML = modelButtons((view.series || view.brand.series[0]).models);
    });
    input.addEventListener("input", function () {
      var q = input.value.trim();
      searchBox.classList.toggle("has", !!input.value);
      clearTimeout(searchTimer);
      if (q.length < 2) {
        if (view.kind === "search") endSearch();
        return;
      }
      searchTimer = setTimeout(function () { runSearch(q); }, 300);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var q = input.value.trim();
        clearTimeout(searchTimer);
        if (q.length >= 2) runSearch(q);
      } else if (e.key === "Escape" && input.value) {
        input.value = "";
        searchBox.classList.remove("has");
        if (view.kind === "search") endSearch();
      }
    });
    searchBox.querySelector(".clear").addEventListener("click", function (e) {
      e.preventDefault();
      input.value = "";
      searchBox.classList.remove("has");
      if (view.kind === "search") endSearch();
      input.focus();
    });
    // a missing photo becomes the box icon
    shadow.addEventListener("error", function (e) {
      var img = e.target;
      if (img && img.tagName === "IMG" && img.parentNode) img.parentNode.innerHTML = ICON_BOX;
    }, true);

    var sizeClass = function () {
      root.classList.toggle("sm", mount.clientWidth > 0 && mount.clientWidth < 560);
    };
    if (window.ResizeObserver) new ResizeObserver(sizeClass).observe(mount);
    else window.addEventListener("resize", sizeClass);
    sizeClass();

    // ── start ──
    function start() {
      loading();
      renderCrumbs();
      api("/widget/spareParts/catalog")
        .then(function (j) {
          catalog = j;
          var b = findBrand(mount.getAttribute("data-brand"));
          var model = mount.getAttribute("data-model");
          var seriesName = mount.getAttribute("data-series");
          if (b && model) return openModel(b, model);
          if (b) {
            var s = null;
            for (var i = 0; i < b.series.length; i++) if (same(b.series[i].name, seriesName)) s = b.series[i];
            return openBrand(b, s);
          }
          go({ kind: "brands" }, true);
        })
        .catch(function () {
          message("The parts list couldn’t be loaded.", true);
        });
    }
    start();
  }

  function boot() {
    var m = document.getElementById(MOUNT_ID);
    if (m) init(m);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
