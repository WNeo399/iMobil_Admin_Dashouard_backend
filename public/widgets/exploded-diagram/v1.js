/*!
 * iMobile Exploded Diagram widget — v1
 *
 * Embed:
 *   <div id="imobile-exploded-diagram" data-api-base="https://<backend>"></div>
 *   <script src="https://<backend>/widget-assets/exploded-diagram/v1.js" defer></script>
 *
 * Optional data attributes on the mount div:
 *   data-diagram="<id>"   open one diagram directly (skips the picker)
 *   data-height="640"     viewer height in px (default 640, min 420)
 *
 * Hand-written vanilla JS (no build step). The viewer replicates the UI of
 * the standalone interactive exploded diagram page (public/exploded-diagram):
 * dark canvas, floating toolbar, left parts panel, minimap, info card and a
 * light mobile layout with FABs + bottom sheet. Renders in a Shadow DOM so
 * host page CSS can't leak in. Data comes from:
 *   GET /widget/explodedDiagram/catalog
 *   GET /widget/explodedDiagram/diagram/:id
 * Hotspots are polygons normalized 0..1 against the image's natural size.
 */
(function () {
  "use strict";

  var MOUNT_ID = "imobile-exploded-diagram";
  var MOBILE_BREAK = 850; // container width, not window width

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;margin:0;padding:0}",
    ".root{position:relative;width:100%;font-family:Inter,system-ui,Arial,sans-serif;",
    "  color:#eef2f7;background:#0d1015;border-radius:14px;overflow:hidden}",
    "button{font:inherit}",
    /* ── picker (light, as before — only the viewer is dark) ── */
    ".picker{padding:26px 22px;background:#fff;color:#111827}",
    ".picker h3{font-size:17px;margin-bottom:4px}",
    ".picker p{font-size:13px;color:#6b7280;margin-bottom:18px}",
    ".sel-row{display:flex;gap:12px;flex-wrap:wrap}",
    ".sel{flex:1;min-width:190px}",
    ".sel label{display:block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:7px}",
    ".sel select{width:100%;font:inherit;font-size:14px;padding:10px 11px;border-radius:9px;color:#111827;",
    "  border:1px solid #d1d5db;background:#fff}",
    ".sel select:focus{outline:none;border-color:#93c5fd;box-shadow:0 0 0 3px rgba(147,197,253,.24)}",
    ".sel select:disabled{opacity:.5;background:#f9fafb}",
    ".diagram-tabs{display:flex;gap:9px;flex-wrap:wrap;margin-top:16px}",
    ".diagram-tab{font-size:13px;color:#111827;padding:8px 13px;border-radius:9px;cursor:pointer;",
    "  border:1px solid #d1d5db;background:#fff}",
    ".diagram-tab:hover{background:#f3f6f9;border-color:#93c5fd}",
    ".msg{padding:30px 20px;font-size:13px;color:#6b7280;text-align:center}",
    /* ── viewer shell ── */
    ".viewer{position:relative;display:none;overflow:hidden;background:#0d1015}",
    ".viewport{position:absolute;inset:0;overflow:hidden;cursor:grab;background:#0d1015;touch-action:none}",
    ".viewport.dragging{cursor:grabbing}",
    ".stage{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}",
    ".stage img{display:block;user-select:none;-webkit-user-drag:none;pointer-events:none}",
    ".stage svg{position:absolute;left:0;top:0}",
    /* hotspot polygons — same colors as the standalone page */
    ".hs{fill:transparent;stroke:transparent;stroke-width:1.4;cursor:pointer;",
    "  vector-effect:non-scaling-stroke;pointer-events:all;-webkit-tap-highlight-color:transparent}",
    ".hs:hover{fill:rgba(126,200,255,.08);stroke:rgba(126,200,255,.8)}",
    ".hs.selected{fill:rgba(255,204,107,.12);stroke:#ffcc6b;stroke-width:2}",
    /* ── floating toolbar ── */
    ".toolbar{position:absolute;left:14px;top:14px;z-index:20;width:250px;display:flex;gap:4px;align-items:center;",
    "  justify-content:space-between;padding:6px;",
    "  background:rgba(18,21,27,.94);border:1px solid rgba(255,255,255,.12);border-radius:12px;",
    "  backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.28)}",
    ".toolbar button{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#eef2f7;",
    "  border-radius:8px;padding:6px 7px;font-size:12px;cursor:pointer;white-space:nowrap}",
    ".toolbar button:hover{background:rgba(255,255,255,.11)}",
    ".zoom-label{font-size:11px;color:#98a3b2;flex:1;min-width:34px;text-align:center}",
    /* ── parts panel ── */
    ".parts{position:absolute;left:14px;top:62px;bottom:14px;width:250px;z-index:20;",
    "  background:rgba(18,21,27,.94);border:1px solid rgba(255,255,255,.12);border-radius:12px;",
    "  backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.28);padding:10px;overflow:auto}",
    ".parts h3{font-size:15px;margin:3px 4px 7px}",
    ".search{width:100%;margin-bottom:8px;border-radius:8px;border:1px solid rgba(255,255,255,.12);",
    "  background:rgba(255,255,255,.05);color:#fff;padding:8px 9px;outline:none;font:inherit;font-size:12px}",
    ".search:focus{border-color:rgba(126,200,255,.55)}",
    ".row{display:flex;justify-content:space-between;gap:8px;padding:7px 8px;border-radius:7px;",
    "  border:1px solid transparent;cursor:pointer;font-size:12px}",
    ".row:hover{background:rgba(255,255,255,.06)}",
    ".row.selected{background:rgba(255,204,107,.1);border-color:rgba(255,204,107,.45)}",
    ".row .name{font-size:10px;color:#98a3b2;text-align:right;display:-webkit-box;-webkit-line-clamp:3;",
    "  -webkit-box-orient:vertical;overflow:hidden}",
    /* ── info card ── */
    ".info{position:absolute;right:14px;bottom:14px;width:290px;z-index:20;",
    "  background:rgba(18,21,27,.94);border:1px solid rgba(255,255,255,.12);border-radius:12px;",
    "  backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.28);padding:13px}",
    ".info .id{font-size:23px;font-weight:800}",
    ".info .name{color:#98a3b2;margin-top:2px}",
    ".info .hint{font-size:11px;line-height:1.5;color:#c7ced8;margin-top:8px}",
    /* linked products (desktop info card) */
    ".prods{display:none;margin-top:10px;border-top:1px solid rgba(255,255,255,.1);padding-top:9px;",
    "  max-height:400px;overflow:auto}",
    ".prods-head{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#98a3b2;margin-bottom:7px}",
    ".prod{display:flex;gap:9px;align-items:center;padding:6px;border-radius:9px;border:1px solid rgba(255,255,255,.1);",
    "  background:rgba(255,255,255,.04);margin-bottom:6px;color:inherit}",
    ".prod-thumb{width:42px;height:42px;border-radius:7px;background:#fff;object-fit:contain;flex:none}",
    ".prod-thumb-ph{display:grid;place-items:center;background:rgba(255,255,255,.08);font-size:16px}",
    ".prod-info{min-width:0}",
    ".prod-title{font-size:11px;line-height:1.35;color:#eef2f7;display:-webkit-box;-webkit-line-clamp:2;",
    "  -webkit-box-orient:vertical;overflow:hidden}",
    ".prod-sku{font-size:10px;color:#98a3b2;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    /* ── fullscreen ── */
    ".fsBtn{position:absolute;top:14px;right:184px;z-index:20;width:40px;height:40px;display:grid;place-items:center;",
    "  border-radius:12px;border:1px solid rgba(255,255,255,.12);background:rgba(18,21,27,.94);color:#eef2f7;",
    "  cursor:pointer;backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.28);font-size:15px}",
    ".fsBtn:hover{background:rgba(255,255,255,.11)}",
    ".root.fs{border-radius:0}",
    /* fallback when the Fullscreen API is unavailable (e.g. iPhone Safari) */
    ".root.fakefs{position:fixed;inset:0;z-index:2147483000;border-radius:0}",
    /* ── minimap ── */
    ".minimap{position:absolute;right:14px;top:14px;width:160px;height:160px;z-index:20;",
    "  background:rgba(18,21,27,.94);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:7px}",
    ".miniWrap{position:relative;width:100%;height:100%;overflow:hidden;border-radius:7px;background:#fff}",
    ".miniImg{width:100%;height:100%;object-fit:contain;display:block}",
    ".miniView{position:absolute;border:1px solid #7ec8ff;background:rgba(126,200,255,.10);pointer-events:none}",
    /* ── mobile layout (root gets .mobile from a width check) ── */
    ".mobileTopbar,.mobileSheet{display:none}",
    ".mobile .toolbar,.mobile .parts,.mobile .info,.mobile .minimap,.mobile .fsBtn{display:none!important}",
    ".mobile .viewport{background:#f6f7f9}",
    ".mobile .hs:hover{fill:transparent;stroke:transparent}",
    ".mobile .hs.selected{fill:rgba(245,158,11,.13);stroke:#f59e0b;stroke-width:2}",
    ".mobile .mobileTopbar{display:flex;position:absolute;top:8px;left:10px;right:10px;z-index:40;",
    "  align-items:center;justify-content:space-between;gap:8px;pointer-events:none}",
    ".mobile-group{display:flex;gap:6px;pointer-events:auto}",
    ".mobileFab{width:44px;height:44px;border-radius:12px;border:1px solid rgba(0,0,0,.08);",
    "  background:rgba(255,255,255,.96);color:#111827;display:grid;place-items:center;font-size:20px;",
    "  box-shadow:0 8px 24px rgba(0,0,0,.12);-webkit-tap-highlight-color:transparent;cursor:pointer}",
    ".mobileFab:active{transform:scale(.96)}",
    ".mobileZoom{pointer-events:auto;min-width:58px;height:44px;display:flex;align-items:center;justify-content:center;",
    "  padding:0 12px;border-radius:12px;background:rgba(255,255,255,.96);color:#374151;",
    "  border:1px solid rgba(0,0,0,.08);box-shadow:0 8px 24px rgba(0,0,0,.12);font-size:12px;font-weight:700}",
    /* very narrow embeds: drop the informational zoom pill so all buttons fit */
    ".narrow .mobileZoom{display:none}",
    ".mobile .mobileSheet{display:block;position:absolute;left:0;right:0;bottom:0;z-index:50;",
    "  background:rgba(255,255,255,.98);color:#111827;border-radius:20px 20px 0 0;",
    "  box-shadow:0 -12px 32px rgba(0,0,0,.16);padding:8px 14px 14px;",
    "  transform:translateY(calc(100% - var(--reveal,76px)));transition:transform .28s ease;max-height:82%;overflow:hidden}",
    ".mobile .mobileSheet.open{transform:translateY(0)}",
    ".sheetHandleWrap{height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer}",
    ".sheetHandle{width:42px;height:5px;border-radius:999px;background:#d1d5db}",
    ".sheetSummary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:46px;cursor:pointer}",
    ".sheetPartText{min-width:0}",
    ".sheetPartId{font-size:17px;font-weight:800;line-height:1.15}",
    ".sheetPartName{font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}",
    ".sheetChevron{font-size:18px;color:#6b7280;transition:transform .2s ease}",
    ".mobileSheet.open .sheetChevron{transform:rotate(180deg)}",
    ".sheetBody{overflow:auto;padding-top:8px}",
    ".mobileSearch{width:100%;height:44px;padding:0 13px;border-radius:12px;border:1px solid #e5e7eb;",
    "  background:#f9fafb;color:#111827;outline:none;font-size:16px;font-family:inherit}",
    ".mobileSearch:focus{border-color:#93c5fd;box-shadow:0 0 0 3px rgba(147,197,253,.24)}",
    ".mobilePartList{margin-top:10px;display:flex;flex-direction:column;gap:6px;padding-bottom:12px}",
    ".mobileRow{width:100%;min-height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px;",
    "  padding:10px 12px;border:1px solid #edf0f3;border-radius:12px;background:#fff;cursor:pointer;",
    "  -webkit-tap-highlight-color:transparent;text-align:left}",
    ".mobileRow:active{background:#f3f6f9}",
    ".mobileRow.selected{border-color:#f4bf58;background:#fff8e8}",
    ".mobileRowCode{font-size:14px;font-weight:800;color:#111827;flex:0 0 auto}",
    ".mobileRowName{font-size:12px;line-height:1.3;color:#6b7280;text-align:right}",
    /* linked products (mobile strip under the sheet summary) */
    ".sheetProds{display:none}",
    ".sheetProds.has{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 10px;-webkit-overflow-scrolling:touch}",
    ".mprod{flex:0 0 112px;display:block;border:1px solid #edf0f3;border-radius:12px;background:#fff;padding:8px;",
    "  color:inherit;-webkit-tap-highlight-color:transparent}",
    ".mprod-thumb{width:100%;height:62px;border-radius:8px;object-fit:contain;background:#f6f7f9;display:block}",
    ".mprod-thumb-ph{display:grid;place-items:center;font-size:18px}",
    ".mprod-title{font-size:11px;line-height:1.3;color:#111827;margin-top:6px;min-height:28px;display:-webkit-box;",
    "  -webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".mprod-sku{font-size:10px;color:#6b7280;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ].join("\n");

  var TIP_CSS =
    ".tip{position:fixed;z-index:2147483001;display:none;pointer-events:none;background:#111820;color:#fff;" +
    "border:1px solid rgba(255,255,255,.15);border-radius:7px;padding:6px 8px;font-size:11px;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.3);font-family:Inter,system-ui,Arial,sans-serif;max-width:280px}";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fetchJson(url) {
    return fetch(url, { mode: "cors", credentials: "omit" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.success === false) {
          throw new Error((data && data.message) || ("Request failed (" + r.status + ")"));
        }
        return data;
      });
    });
  }

  function joinUrl(base, path) {
    return String(base || "").replace(/\/+$/, "") + path;
  }

  function mount(host) {
    var apiBase = host.getAttribute("data-api-base") || "";
    if (!apiBase) {
      host.textContent = "Exploded diagram widget: data-api-base is missing.";
      return;
    }
    var fixedDiagram = host.getAttribute("data-diagram") || "";
    // Viewer height: 90vh with a 760px floor by default; a data-height
    // attribute (px) overrides both when an embedder wants a fixed size.
    var heightAttr = parseInt(host.getAttribute("data-height"), 10);

    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : null;
    var rootHost = shadow || host;
    var style = document.createElement("style");
    style.textContent = CSS + "\n" + TIP_CSS;
    rootHost.appendChild(style);

    var root = el("div", "root");
    rootHost.appendChild(root);

    var picker = el("div", "picker");
    root.appendChild(picker);

    // ── viewer scaffold (v7 layout) ─────────────────────────────────
    var viewer = el("div", "viewer");
    if (heightAttr) {
      viewer.style.height = Math.max(420, heightAttr) + "px";
    } else {
      viewer.style.height = "90vh";
      viewer.style.minHeight = "760px";
    }
    root.appendChild(viewer);

    var viewport = el("div", "viewport");
    viewer.appendChild(viewport);
    var stage = el("div", "stage");
    viewport.appendChild(stage);
    var img = document.createElement("img");
    stage.appendChild(img);
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    stage.appendChild(svg);

    // toolbar
    var toolbar = el("div", "toolbar");
    var backBtn = el("button", null, "‹ Back");
    var fitBtn = el("button", null, "Fit");
    var resetBtn = el("button", null, "100%");
    var zoomOutB = el("button", null, "−");
    var zoomLabel = el("span", "zoom-label", "100%");
    var zoomInB = el("button", null, "+");
    [backBtn, fitBtn, resetBtn, zoomOutB, zoomLabel, zoomInB].forEach(function (n) { toolbar.appendChild(n); });
    viewer.appendChild(toolbar);

    // parts panel
    var parts = el("aside", "parts");
    parts.appendChild(el("h3", null, "Parts"));
    var search = document.createElement("input");
    search.className = "search";
    search.placeholder = "Search part number…";
    parts.appendChild(search);
    var partList = el("div", "partList");
    parts.appendChild(partList);
    viewer.appendChild(parts);

    // minimap
    var minimap = el("div", "minimap");
    var miniWrap = el("div", "miniWrap");
    var miniImg = document.createElement("img");
    miniImg.className = "miniImg";
    miniImg.alt = "";
    var miniView = el("div", "miniView");
    miniWrap.appendChild(miniImg);
    miniWrap.appendChild(miniView);
    minimap.appendChild(miniWrap);
    viewer.appendChild(minimap);

    // fullscreen toggle (desktop; the mobile FAB is added below)
    var fsBtn = el("button", "fsBtn", "⛶");
    fsBtn.title = "Full screen";
    viewer.appendChild(fsBtn);

    // info card
    var info = el("section", "info");
    var infoId = el("div", "id", "Select a part");
    var infoName = el("div", "name", "Interactive exploded diagram");
    var infoHint = el("div", "hint",
      "Click a component on the image or select its part number from the left. " +
      "The viewer will smoothly zoom to that component. Mouse wheel zooms; drag pans.");
    info.appendChild(infoId);
    info.appendChild(infoName);
    info.appendChild(infoHint);
    var prodsBox = el("div", "prods");
    info.appendChild(prodsBox);
    viewer.appendChild(info);

    // mobile topbar + sheet
    var mobileTopbar = el("div", "mobileTopbar");
    var mgLeft = el("div", "mobile-group");
    var mBack = el("button", "mobileFab", "‹");
    var mFit = el("button", "mobileFab", "⌂");
    var mSearchBtn = el("button", "mobileFab", "⌕");
    var mFs = el("button", "mobileFab", "⛶");
    mgLeft.appendChild(mBack); mgLeft.appendChild(mFit); mgLeft.appendChild(mSearchBtn); mgLeft.appendChild(mFs);
    var mgRight = el("div", "mobile-group");
    var mZoom = el("div", "mobileZoom", "100%");
    var mMinus = el("button", "mobileFab", "−");
    var mPlus = el("button", "mobileFab", "+");
    mgRight.appendChild(mZoom); mgRight.appendChild(mMinus); mgRight.appendChild(mPlus);
    mobileTopbar.appendChild(mgLeft); mobileTopbar.appendChild(mgRight);
    viewer.appendChild(mobileTopbar);

    var mobileSheet = el("section", "mobileSheet");
    var sheetHandleWrap = el("div", "sheetHandleWrap");
    sheetHandleWrap.appendChild(el("div", "sheetHandle"));
    var sheetSummary = el("div", "sheetSummary");
    var sheetPartText = el("div", "sheetPartText");
    var sheetPartId = el("div", "sheetPartId", "Tap a part");
    var sheetPartName = el("div", "sheetPartName", "Select from the diagram or search below");
    sheetPartText.appendChild(sheetPartId); sheetPartText.appendChild(sheetPartName);
    var sheetChevron = el("div", "sheetChevron", "⌃");
    sheetSummary.appendChild(sheetPartText); sheetSummary.appendChild(sheetChevron);
    var sheetBody = el("div", "sheetBody");
    var mobileSearch = document.createElement("input");
    mobileSearch.className = "mobileSearch";
    mobileSearch.placeholder = "Search part number or name…";
    mobileSearch.autocomplete = "off";
    var mobilePartList = el("div", "mobilePartList");
    sheetBody.appendChild(mobileSearch); sheetBody.appendChild(mobilePartList);
    var sheetProds = el("div", "sheetProds");
    mobileSheet.appendChild(sheetHandleWrap); mobileSheet.appendChild(sheetSummary);
    mobileSheet.appendChild(sheetProds); mobileSheet.appendChild(sheetBody);
    viewer.appendChild(mobileSheet);

    // Tooltip lives INSIDE the shadow root: position:fixed escapes the
    // root's overflow clipping anyway (no transform on .root), host-page CSS
    // can't reach it, and — critically — it still renders in native
    // fullscreen, where only the fullscreened element's subtree is shown.
    var tip = el("div", "tip");
    root.appendChild(tip);

    // ── responsive: container width decides the layout ──────────────
    function isMobile() { return root.classList.contains("mobile"); }
    function checkMobile() {
      var w = root.getBoundingClientRect().width || host.clientWidth || 0;
      var was = root.classList.contains("mobile");
      var now = w > 0 && w <= MOBILE_BREAK;
      root.classList.toggle("mobile", now);
      root.classList.toggle("narrow", now && w < 370);
      // Measure the live viewer height (vh-based by default, so it changes
      // with the window); 0 while the picker is showing → fall back.
      var vh = viewer.getBoundingClientRect().height || 760;
      sheetBody.style.height = Math.round(vh * 0.72 - 82) + "px";
      // strip height is only measurable in mobile layout — recompute the
      // collapsed-sheet reveal when the layout flips
      if (was !== now && selectedId) renderProducts(findPart(selectedId));
    }
    checkMobile();
    // Window resize always re-checks; the observer additionally catches
    // container-only resizes (host page layout changes without a window resize).
    window.addEventListener("resize", checkMobile);
    if (window.ResizeObserver) new ResizeObserver(checkMobile).observe(root);

    // ── viewer state (math from the standalone page) ────────────────
    var IMG_W = 0, IMG_H = 0;
    var scale = 1, tx = 0, ty = 0;
    var targetScale = 1, targetTx = 0, targetTy = 0;
    var animating = false;
    var partData = [];
    var selectedId = null;
    var sheetRevealPx = 76; // collapsed sheet height; grows when products show

    var SHOP_BASE = "https://www.imobilestore.com.au";
    function shopUrl(path) {
      if (!path) return "";
      return /^https?:\/\//i.test(path) ? path : SHOP_BASE + path;
    }
    function buildProdThumb(pr, cls) {
      var src = shopUrl(pr.imageUrl);
      if (src) {
        var t = document.createElement("img");
        t.className = cls;
        t.alt = "";
        t.src = src;
        t.onerror = function () { t.style.display = "none"; };
        return t;
      }
      return el("div", cls + " " + cls + "-ph", "📦");
    }
    function buildProdCard(pr, cls) {
      // Deliberately NOT a link: the widget may be embedded on other
      // businesses' sites, and product cards must not funnel their visitors
      // to the iMobile shop. (The stored product url stays in the data.)
      var card = el("div", cls);
      card.appendChild(buildProdThumb(pr, cls + "-thumb"));
      var box = card;
      if (cls === "prod") { // desktop rows keep text beside the thumb
        box = el("div", "prod-info");
        card.appendChild(box);
      }
      var titleEl = el("div", cls + "-title", pr.title || pr.sku || "Product");
      box.appendChild(titleEl);
      if (pr.sku) box.appendChild(el("div", cls + "-sku", "SKU: " + pr.sku));
      if (cls === "prod") {
        // full product title in a tooltip when the 2-line clamp cut it off
        card.addEventListener("mouseenter", function () {
          if (isMobile() || titleEl.scrollHeight <= titleEl.clientHeight + 1) return;
          tip.style.display = "block";
          tip.textContent = pr.title || "";
        });
        card.addEventListener("mousemove", function (e) {
          if (tip.style.display !== "block") return;
          tip.style.left = (e.clientX + 12) + "px";
          tip.style.top = (e.clientY + 12) + "px";
        });
        card.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      }
      return card;
    }
    function renderProducts(p) {
      var items = (p && p.products) || [];
      prodsBox.innerHTML = "";
      sheetProds.innerHTML = "";
      var has = items.length > 0;
      prodsBox.style.display = has ? "block" : "none";
      sheetProds.classList.toggle("has", has);
      if (has) {
        prodsBox.appendChild(el("div", "prods-head",
          items.length === 1 ? "Product" : "Products (" + items.length + ")"));
        items.forEach(function (pr) {
          prodsBox.appendChild(buildProdCard(pr, "prod"));
          sheetProds.appendChild(buildProdCard(pr, "mprod"));
        });
      }
      updateSheetReveal();
    }
    // Collapsed-sheet height: keeps the product strip visible below the summary.
    function updateSheetReveal() {
      var has = sheetProds.classList.contains("has");
      sheetRevealPx = 76 + (has ? Math.min(170, sheetProds.offsetHeight || 132) : 0);
      mobileSheet.style.setProperty("--reveal", sheetRevealPx + "px");
    }

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function applyTransform() {
      stage.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
      var pct = Math.round(scale * 100) + "%";
      zoomLabel.textContent = pct;
      mZoom.textContent = pct;
      updateMiniMap();
    }
    function setTransform(s, x, y, animate) {
      targetScale = clamp(s, 0.15, 8);
      targetTx = x; targetTy = y;
      if (!animate) { scale = targetScale; tx = targetTx; ty = targetTy; applyTransform(); return; }
      if (!animating) { animating = true; requestAnimationFrame(stepAnim); }
    }
    function stepAnim() {
      scale += (targetScale - scale) * 0.18;
      tx += (targetTx - tx) * 0.18;
      ty += (targetTy - ty) * 0.18;
      applyTransform();
      if (Math.abs(scale - targetScale) > 0.001 || Math.abs(tx - targetTx) > 0.25 || Math.abs(ty - targetTy) > 0.25) {
        requestAnimationFrame(stepAnim);
      } else {
        scale = targetScale; tx = targetTx; ty = targetTy; applyTransform(); animating = false;
      }
    }
    function fitImage() {
      var r = viewport.getBoundingClientRect();
      if (!IMG_W || !r.width) return;
      if (isMobile()) {
        // reserve the collapsed bottom-sheet area (taller when products show)
        var reservedBottom = sheetRevealPx + 16;
        var availH = Math.max(220, r.height - reservedBottom);
        var ms = Math.min(r.width / IMG_W, availH / IMG_H) * 0.96;
        setTransform(ms, (r.width - IMG_W * ms) / 2, Math.max(52, (availH - IMG_H * ms) / 2 + 28), true);
        return;
      }
      var s = Math.min(r.width / IMG_W, r.height / IMG_H) * 0.94;
      setTransform(s, (r.width - IMG_W * s) / 2, (r.height - IMG_H * s) / 2, true);
    }
    function reset100() {
      var r = viewport.getBoundingClientRect();
      setTransform(1, (r.width - IMG_W) / 2, (r.height - IMG_H) / 2, true);
    }
    function zoomAt(clientX, clientY, factor) {
      var rect = viewport.getBoundingClientRect();
      var px = clientX - rect.left, py = clientY - rect.top;
      var ix = (px - tx) / scale, iy = (py - ty) / scale;
      var ns = clamp(scale * factor, 0.15, 8);
      setTransform(ns, px - ix * ns, py - iy * ns, false);
    }
    function centerZoom(factor) {
      var r = viewport.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }
    function partBox(p) {
      var xs = p.points.map(function (pt) { return pt[0] * IMG_W; });
      var ys = p.points.map(function (pt) { return pt[1] * IMG_H; });
      return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
    }
    function zoomToPart(p) {
      var box = partBox(p);
      var pad = 55;
      var bw = (box[2] - box[0]) + pad * 2, bh = (box[3] - box[1]) + pad * 2;
      var vr = viewport.getBoundingClientRect();
      // Desktop: center the part in the region clear of the parts panel
      // (left), toolbar (top) and info card (bottom-right) — this nudges the
      // zoomed part toward the top-left so the info card doesn't cover it.
      // Mobile: unchanged — only the bottom sheet is reserved.
      var padL = 285, padR = 150, padT = 62, padB = 170;
      var usableW = isMobile() ? vr.width : Math.max(320, vr.width - padL - padR);
      var usableH = isMobile() ? Math.max(200, vr.height - sheetRevealPx - 70) : Math.max(240, vr.height - padT - padB);
      // Cap the part zoom at ~90% of the image's natural resolution so small
      // parts don't blow up into a pixelated close-up. For low-res images
      // (where even Fit exceeds that), still allow a step past the fit scale.
      var fitS = Math.min(vr.width / IMG_W, vr.height / IMG_H);
      var maxZoom = Math.max(0.9, fitS * 1.4);
      var ns = clamp(Math.min(usableW / bw, usableH / bh), Math.min(0.55, maxZoom), maxZoom);
      var cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      var centerX = isMobile() ? vr.width / 2 : padL + usableW / 2;
      var centerY = isMobile() ? 52 + (vr.height - sheetRevealPx - 52) / 2 : padT + usableH / 2;
      setTransform(ns, centerX - cx * ns, centerY - cy * ns, true);
    }
    function findPart(id) {
      for (var i = 0; i < partData.length; i++) if (partData[i].id === id) return partData[i];
      return null;
    }
    function partLabel(p) { return p.partNumber || p.title || "—"; }

    function selectPart(id, zoom) {
      selectedId = id;
      var p = findPart(id);
      svg.querySelectorAll(".hs").forEach(function (n) {
        n.classList.toggle("selected", n.getAttribute("data-id") === id);
      });
      partList.querySelectorAll(".row").forEach(function (n) {
        n.classList.toggle("selected", n.getAttribute("data-id") === id);
      });
      mobilePartList.querySelectorAll(".mobileRow").forEach(function (n) {
        n.classList.toggle("selected", n.getAttribute("data-id") === id);
      });
      if (!p) return;
      infoId.textContent = partLabel(p);
      infoName.textContent = p.title || "";
      infoHint.style.display = "none";
      sheetPartId.textContent = partLabel(p);
      sheetPartName.textContent = p.title || "";
      renderProducts(p);
      if (isMobile()) setSheetOpen(false);
      if (zoom) zoomToPart(p);
      var row = partList.querySelector('.row[data-id="' + id + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }

    // ── rendering ───────────────────────────────────────────────────
    function polyArea(p) {
      var s = 0;
      for (var i = 0; i < p.points.length; i++) {
        var a = p.points[i];
        var b = p.points[(i + 1) % p.points.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(s);
    }
    function renderHotspots() {
      svg.innerHTML = "";
      svg.setAttribute("width", IMG_W);
      svg.setAttribute("height", IMG_H);
      svg.setAttribute("viewBox", "0 0 " + IMG_W + " " + IMG_H);
      // big polygons first, small last: SVG hit-tests in render order, so a
      // small part inside a big one stays clickable
      partData.slice().sort(function (a, b) { return polyArea(b) - polyArea(a); }).forEach(function (p) {
        var poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("class", "hs");
        poly.setAttribute("data-id", p.id);
        poly.setAttribute("points", p.points.map(function (pt) {
          return (pt[0] * IMG_W).toFixed(1) + "," + (pt[1] * IMG_H).toFixed(1);
        }).join(" "));
        poly.addEventListener("click", function (e) { e.stopPropagation(); selectPart(p.id, true); });
        poly.addEventListener("mouseenter", function () {
          if (isMobile()) return;
          tip.style.display = "block";
          tip.textContent = partLabel(p) + (p.title && p.partNumber ? " — " + p.title : "");
        });
        poly.addEventListener("mousemove", function (e) {
          tip.style.left = (e.clientX + 12) + "px";
          tip.style.top = (e.clientY + 12) + "px";
        });
        poly.addEventListener("mouseleave", function () { tip.style.display = "none"; });
        svg.appendChild(poly);
      });
    }
    function matches(p, q) {
      return !q ||
        (p.partNumber || "").toLowerCase().indexOf(q) !== -1 ||
        (p.title || "").toLowerCase().indexOf(q) !== -1;
    }
    function renderList(filter) {
      var q = String(filter || "").trim().toLowerCase();
      partList.innerHTML = "";
      partData.forEach(function (p) {
        if (!matches(p, q)) return;
        var row = el("div", "row" + (p.id === selectedId ? " selected" : ""));
        row.setAttribute("data-id", p.id);
        row.appendChild(el("span", null, partLabel(p)));
        var nameEl = el("span", "name", p.title || "");
        row.appendChild(nameEl);
        row.onclick = function () { selectPart(p.id, true); };
        // full title in a tooltip when the 3-line clamp actually cut it off
        row.addEventListener("mouseenter", function () {
          if (isMobile() || nameEl.scrollHeight <= nameEl.clientHeight + 1) return;
          tip.style.display = "block";
          tip.textContent = p.title;
        });
        row.addEventListener("mousemove", function (e) {
          if (tip.style.display !== "block") return;
          tip.style.left = (e.clientX + 12) + "px";
          tip.style.top = (e.clientY + 12) + "px";
        });
        row.addEventListener("mouseleave", function () { tip.style.display = "none"; });
        partList.appendChild(row);
      });
    }
    function renderMobileList(filter) {
      var q = String(filter || "").trim().toLowerCase();
      mobilePartList.innerHTML = "";
      partData.forEach(function (p) {
        if (!matches(p, q)) return;
        var row = document.createElement("button");
        row.className = "mobileRow" + (p.id === selectedId ? " selected" : "");
        row.setAttribute("data-id", p.id);
        row.appendChild(el("span", "mobileRowCode", partLabel(p)));
        row.appendChild(el("span", "mobileRowName", p.title || ""));
        row.onclick = function () { selectPart(p.id, true); setSheetOpen(false); };
        mobilePartList.appendChild(row);
      });
    }
    search.addEventListener("input", function () { renderList(search.value); });
    mobileSearch.addEventListener("input", function () { renderMobileList(mobileSearch.value); });

    // ── minimap ─────────────────────────────────────────────────────
    function updateMiniMap() {
      if (!IMG_W || isMobile()) return;
      var mini = miniWrap.getBoundingClientRect();
      var vr = viewport.getBoundingClientRect();
      if (!mini.width || !vr.width) return;
      var sx = mini.width / IMG_W, sy = mini.height / IMG_H;
      miniView.style.left = clamp((-tx / scale) * sx, 0, mini.width) + "px";
      miniView.style.top = clamp((-ty / scale) * sy, 0, mini.height) + "px";
      miniView.style.width = clamp((vr.width / scale) * sx, 4, mini.width) + "px";
      miniView.style.height = clamp((vr.height / scale) * sy, 4, mini.height) + "px";
    }

    // ── sheet ───────────────────────────────────────────────────────
    function setSheetOpen(open) { mobileSheet.classList.toggle("open", open); }
    sheetSummary.addEventListener("click", function () { setSheetOpen(!mobileSheet.classList.contains("open")); });
    sheetHandleWrap.addEventListener("click", function () { setSheetOpen(!mobileSheet.classList.contains("open")); });
    mSearchBtn.addEventListener("click", function () {
      setSheetOpen(true);
      setTimeout(function () { mobileSearch.focus(); }, 220);
    });

    // ── pointer interactions ────────────────────────────────────────
    var dragging = false, moved = false, lastX = 0, lastY = 0;
    var pointers = new Map();
    var pinchStart = null;

    viewport.addEventListener("pointerdown", function (e) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var rect = viewport.getBoundingClientRect();
        var cx = (pts[0].x + pts[1].x) / 2 - rect.left;
        var cy = (pts[0].y + pts[1].y) / 2 - rect.top;
        pinchStart = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          scale: scale,
          ix: (cx - tx) / scale,
          iy: (cy - ty) / scale,
          cx: cx, cy: cy,
        };
        dragging = false;
        return;
      }
      dragging = true; moved = false;
      lastX = e.clientX; lastY = e.clientY;
      viewport.classList.add("dragging");
      // No pointer capture on press — capturing retargets the coming click
      // to the viewport and swallows hotspot clicks. Capture starts once
      // real pan movement begins (below).
    });
    viewport.addEventListener("pointermove", function (e) {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinchStart && pointers.size === 2) {
        var pts = Array.from(pointers.values());
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        var ns = clamp(pinchStart.scale * (dist / pinchStart.dist), 0.15, 8);
        tx = pinchStart.cx - pinchStart.ix * ns;
        ty = pinchStart.cy - pinchStart.iy * ns;
        scale = targetScale = ns; targetTx = tx; targetTy = ty;
        applyTransform();
        return;
      }
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 2) {
        moved = true;
        viewport.setPointerCapture && viewport.setPointerCapture(e.pointerId);
      }
      lastX = e.clientX; lastY = e.clientY;
      tx += dx; ty += dy;
      targetTx = tx; targetTy = ty; targetScale = scale;
      applyTransform();
    });
    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      dragging = false;
      viewport.classList.remove("dragging");
    }
    viewport.addEventListener("pointerup", endPointer);
    viewport.addEventListener("pointercancel", endPointer);
    viewport.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.14 : 1 / 1.14);
    }, { passive: false });
    viewport.addEventListener("dblclick", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("hs")) return;
      fitImage();
    });

    // ── fullscreen ──────────────────────────────────────────────────
    // Native Fullscreen API on the host div; a fixed-overlay fallback covers
    // browsers without it (iPhone Safari). Esc exits either mode.
    var fakeFs = false, fsPrevH = "", fsPrevMinH = "";
    function nativeFsEl() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    }
    function applyFsLayout(on) {
      if (on) {
        fsPrevH = viewer.style.height;
        fsPrevMinH = viewer.style.minHeight;
        viewer.style.height = "100vh";
        viewer.style.minHeight = "0";
      } else {
        viewer.style.height = fsPrevH;
        viewer.style.minHeight = fsPrevMinH;
      }
      root.classList.toggle("fs", on);
      root.classList.toggle("fakefs", on && fakeFs);
      fsBtn.textContent = on ? "✕" : "⛶";
      fsBtn.title = on ? "Exit full screen" : "Full screen";
      mFs.textContent = on ? "✕" : "⛶";
      checkMobile();
      setTimeout(fitImage, 60); // re-fit once the new size has settled
    }
    function enterFs() {
      var req = host.requestFullscreen || host.webkitRequestFullscreen;
      if (req) {
        try {
          Promise.resolve(req.call(host)).catch(function () {
            fakeFs = true;
            applyFsLayout(true);
          });
          return;
        } catch (e) { /* fall through to the overlay */ }
      }
      fakeFs = true;
      applyFsLayout(true);
    }
    function exitFs() {
      if (fakeFs) {
        fakeFs = false;
        applyFsLayout(false);
        return;
      }
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex && nativeFsEl() === host) ex.call(document);
    }
    function toggleFs() {
      if (fakeFs || nativeFsEl() === host) exitFs();
      else enterFs();
    }
    function onFsChange() {
      if (!fakeFs) applyFsLayout(nativeFsEl() === host);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && fakeFs) exitFs();
    });
    fsBtn.onclick = toggleFs;
    mFs.onclick = toggleFs;

    fitBtn.onclick = fitImage;
    resetBtn.onclick = reset100;
    zoomInB.onclick = function () { centerZoom(1.2); };
    zoomOutB.onclick = function () { centerZoom(1 / 1.2); };
    mFit.onclick = fitImage;
    mPlus.onclick = function () { centerZoom(1.25); };
    mMinus.onclick = function () { centerZoom(1 / 1.25); };

    // ── flow ────────────────────────────────────────────────────────
    var resetPicker = null; // assigned by buildPicker
    function showPicker() {
      exitFs(); // leaving the viewer also leaves full screen (no-op otherwise)
      viewer.style.display = "none";
      picker.style.display = "block";
      if (resetPicker) resetPicker();
    }
    backBtn.onclick = showPicker;
    mBack.onclick = showPicker;

    function loadDiagram(id) {
      picker.style.display = "none";
      viewer.style.display = "block";
      checkMobile(); // viewer just became measurable — size the sheet body
      infoId.textContent = "Loading…";
      infoName.textContent = "";
      fetchJson(joinUrl(apiBase, "/widget/explodedDiagram/diagram/" + encodeURIComponent(id)))
        .then(function (r) {
          var d = r.diagram;
          IMG_W = d.image.width; IMG_H = d.image.height;
          img.width = IMG_W; img.height = IMG_H;
          partData = d.hotspots || [];
          selectedId = null;
          infoId.textContent = "Select a part";
          infoName.textContent = d.brand + " " + d.model;
          infoHint.style.display = "";
          infoHint.textContent =
            "Click a component on the image or select its part number from the left. " +
            "The viewer will smoothly zoom to that component. Mouse wheel zooms; drag pans.";
          sheetPartId.textContent = "Tap a part";
          sheetPartName.textContent = "Select from the diagram or search below";
          renderProducts(null);
          setSheetOpen(false);
          img.onload = function () { renderHotspots(); fitImage(); };
          img.src = d.image.url;
          miniImg.src = d.image.url;
          if (img.complete) { renderHotspots(); fitImage(); }
          renderList("");
          renderMobileList("");
          search.value = "";
          mobileSearch.value = "";
        })
        .catch(function (e) {
          infoId.textContent = "Failed to load";
          infoName.textContent = e.message;
        });
    }

    function buildPicker(brands) {
      picker.innerHTML = "";
      picker.appendChild(el("h3", null, "Exploded Diagrams"));
      picker.appendChild(el("p", null, "Pick a brand and model to open its parts diagram."));
      var rowBox = el("div", "sel-row");
      picker.appendChild(rowBox);

      var brandSel = el("div", "sel");
      brandSel.appendChild(el("label", null, "Brand"));
      var brandSelect = document.createElement("select");
      brandSel.appendChild(brandSelect);
      rowBox.appendChild(brandSel);

      var modelSel = el("div", "sel");
      modelSel.appendChild(el("label", null, "Model"));
      var modelSelect = document.createElement("select");
      modelSel.appendChild(modelSelect);
      rowBox.appendChild(modelSel);

      var tabs = el("div", "diagram-tabs");
      picker.appendChild(tabs);

      function opt(select, value, label) {
        var o = document.createElement("option");
        o.value = value; o.textContent = label;
        select.appendChild(o);
        return o;
      }

      opt(brandSelect, "", "Select a brand…");
      brands.forEach(function (b) { opt(brandSelect, b.brand, b.brand); });

      function refreshModels() {
        modelSelect.innerHTML = "";
        tabs.innerHTML = "";
        var b = null;
        brands.forEach(function (x) { if (x.brand === brandSelect.value) b = x; });
        if (!b) { opt(modelSelect, "", "Select a brand first"); modelSelect.disabled = true; return; }
        modelSelect.disabled = false;
        opt(modelSelect, "", "Select a model…");
        b.models.forEach(function (m) { opt(modelSelect, m.model, m.model); });
      }
      function refreshDiagrams() {
        tabs.innerHTML = "";
        var b = null, m = null;
        brands.forEach(function (x) { if (x.brand === brandSelect.value) b = x; });
        if (b) b.models.forEach(function (x) { if (x.model === modelSelect.value) m = x; });
        if (!m) return;
        if (m.diagrams.length === 1) { loadDiagram(m.diagrams[0].id); return; }
        m.diagrams.forEach(function (d) {
          var btn = el("button", "diagram-tab", d.title || (m.model + " diagram"));
          btn.addEventListener("click", function () { loadDiagram(d.id); });
          tabs.appendChild(btn);
        });
      }
      brandSelect.addEventListener("change", refreshModels);
      modelSelect.addEventListener("change", refreshDiagrams);
      refreshModels();
      resetPicker = function () {
        brandSelect.value = "";
        refreshModels();
      };
    }

    if (fixedDiagram) {
      backBtn.style.display = "none";
      mBack.style.display = "none";
      loadDiagram(fixedDiagram);
    } else {
      picker.appendChild(el("div", "msg", "Loading…"));
      fetchJson(joinUrl(apiBase, "/widget/explodedDiagram/catalog"))
        .then(function (r) {
          if (!r.brands || !r.brands.length) {
            picker.innerHTML = "";
            picker.appendChild(el("div", "msg", "No diagrams are available yet."));
            return;
          }
          buildPicker(r.brands);
        })
        .catch(function (e) {
          picker.innerHTML = "";
          picker.appendChild(el("div", "msg", "Failed to load diagrams: " + e.message));
        });
    }
  }

  function boot() {
    var host = document.getElementById(MOUNT_ID);
    if (host) mount(host);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
