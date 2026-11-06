/*!
 * iMobile Embed Ordering widget — v1 (demo)
 *
 * Embed (the distributor's key comes from Embed Ordering → Ordering Widget):
 *   <div id="imobile-embed-ordering" data-distributor-key="embed_…"></div>
 *   <script src="https://<backend>/widget-assets/embed-ordering/v1.js" defer></script>
 *
 * Optional data attributes on the mount div:
 *   data-api-base="https://<backend>"   where the parts come from (default: the
 *                                       server this script was loaded from)
 *   data-title="Order parts"            heading; data-title="" hides it
 *   data-accent="#0b7fd4"               colour of buttons and selected tabs
 *   data-brand / data-series / data-model   open straight on a brand or model
 *
 * A copy of the Listing Widget (public/widgets/spare-parts/v1.js) turned into
 * an ordering interface: the customer signs in first (no parts are shown
 * before that), then browses Brand → Series → Model → part type or searches,
 * adds in-stock parts to a cart, places the order and sees My orders.
 * Demo build (2026-11-06): sign in by email only, no prices, payment on
 * account; orders land on the dashboard (Embed Ordering → Orders).
 * The cart and sign-in are kept in this website's localStorage, per key.
 * Hand-written vanilla JS, no build step, in a Shadow DOM so the host page's
 * CSS can't leak in. Layout follows the CONTAINER's width.
 * Models with a published 3D diagram (dashboard: Embed Ordering → 3D Diagrams)
 * open on the parts list as usual, with a switch to a "3D view" (user,
 * 2026-11-06): turn and separate the model, click a part to see its
 * items and add them to the cart. Its code (./viewer3d.js + three.js from
 * ../vendor/) is loaded only then.
 * Data: /widget/embed-ordering/catalog | /parts | /search | /diagram3d | /login | /logout | /me | /orders
 */
(function () {
  "use strict";

  var MOUNT_ID = "imobile-embed-ordering";
  var IMG_BASE = "https://www.imobilestore.com.au/product-images/image/";
  var PAGE = 36; // cards before "Show more"
  var MAX_QTY = 999;
  var SCRIPT = document.currentScript;

  var CSS = [
    ":host{all:initial;display:block}",
    "*{box-sizing:border-box}",
    ".root{--accent:#0b7fd4;--text:#1f2937;--muted:#6b7280;--line:#e5e7eb;--soft:#f3f4f6;--ok:#15803d;--bad:#b91c1c;",
    "  font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.45;",
    "  color:var(--text);background:#fff;-webkit-tap-highlight-color:transparent}",
    "button{font:inherit;color:inherit}",
    "input,textarea{font:inherit;color:inherit}",
    ".head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}",
    ".title{font-size:20px;font-weight:700;margin:0;flex:1 1 auto}",
    ".search{position:relative;flex:0 1 320px;min-width:200px}",
    ".search input{width:100%;height:40px;border:1px solid var(--line);border-radius:10px;padding:0 36px 0 38px;background:#fff;outline:none}",
    ".search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(11,127,212,.15)}",
    ".search .ico{position:absolute;left:12px;top:11px;width:18px;height:18px;color:var(--muted)}",
    ".search .clear{position:absolute;right:6px;top:6px;width:28px;height:28px;border:0;background:none;border-radius:6px;cursor:pointer;color:var(--muted);display:none}",
    ".search.has .clear{display:block}",
    ".acts{display:flex;gap:8px;align-items:center}",
    ".hbtn{height:40px;border:1px solid var(--line);background:#fff;border-radius:10px;padding:0 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;max-width:200px}",
    ".hbtn:hover{border-color:var(--accent)}",
    ".hbtn svg{width:18px;height:18px;flex:none}",
    ".hbtn .lbl{overflow:hidden;text-overflow:ellipsis}",
    ".badge{min-width:20px;height:20px;border-radius:10px;background:var(--accent);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}",
    ".badge.zero{background:var(--soft);color:var(--muted)}",
    ".crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:4px;font-size:13px;color:var(--muted);margin-bottom:12px;min-height:20px}",
    ".crumbs button{border:0;background:none;padding:0;color:var(--accent);cursor:pointer}",
    ".crumbs button:hover{text-decoration:underline}",
    ".crumbs .sep{opacity:.6}",
    ".crumbs .here{color:var(--text);font-weight:600}",
    ".grid{display:grid;gap:10px}",
    ".tiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}",
    ".tile{border:1px solid var(--line);border-radius:12px;background:#fff;padding:16px 14px;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}",
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
    ".seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;overflow:hidden;margin-bottom:12px;max-width:100%}",
    ".seg button{border:0;border-left:1px solid var(--line);background:#fff;padding:6px 14px;cursor:pointer;font-size:13px;white-space:nowrap}",
    ".seg button:first-child{border-left:0}",
    ".seg button:hover{color:var(--accent)}",
    ".seg button[aria-pressed='true']{background:var(--accent);color:#fff}",
    ".seg .k{opacity:.75;margin-left:4px;font-size:12px}",
    ".filter{height:34px;border:1px solid var(--line);border-radius:8px;padding:0 10px;outline:none;width:220px;max-width:100%}",
    ".filter:focus{border-color:var(--accent)}",
    ".models{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}",
    ".model{border:1px solid var(--line);border-radius:10px;background:#fff;padding:10px 12px;text-align:left;cursor:pointer}",
    ".model:hover{border-color:var(--accent)}",
    ".model .n{font-weight:600}",
    ".model .c{font-size:12px;color:var(--muted)}",
    ".cards{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}",
    ".card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;transition:border-color .15s,box-shadow .15s}",
    ".card.incart{border-color:var(--accent)}",
    ".card.out .pic{opacity:.55}",
    "button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}",
    ".pic{aspect-ratio:1/1;background:var(--soft);display:flex;align-items:center;justify-content:center}",
    ".pic img{width:100%;height:100%;object-fit:contain;display:block;background:#fff}",
    ".pic svg{width:42px;height:42px;color:#c4c9d1}",
    ".info{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1}",
    ".name{font-size:13px;font-weight:600;overflow-wrap:anywhere}",
    ".meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--muted)}",
    ".tag{background:var(--soft);border-radius:4px;padding:1px 6px;color:var(--text)}",
    ".stock{font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px}",
    ".stock:before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}",
    ".stock.yes{color:var(--ok)}",
    ".stock.no{color:var(--muted)}",
    ".buy{margin-top:auto;padding-top:2px}",
    ".add{width:100%;height:34px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}",
    ".add:hover{filter:brightness(1.07)}",
    ".add[disabled]{background:var(--soft);color:var(--muted);cursor:not-allowed;filter:none}",
    ".step{display:flex;align-items:center;border:1px solid var(--accent);border-radius:8px;overflow:hidden;height:34px}",
    ".step button{width:34px;height:100%;border:0;background:#fff;cursor:pointer;font-size:18px;line-height:1;color:var(--accent);flex:none}",
    ".step button:hover{background:var(--soft)}",
    ".step input{flex:1;min-width:0;height:100%;border:0;text-align:center;font-weight:600;outline:none;-moz-appearance:textfield}",
    ".step input::-webkit-outer-spin-button,.step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}",
    ".section{font-size:13px;font-weight:600;color:var(--muted);margin:14px 0 8px}",
    ".count{font-size:13px;color:var(--muted)}",
    ".more{display:block;margin:14px auto 0;border:1px solid var(--line);background:#fff;border-radius:999px;padding:8px 20px;cursor:pointer}",
    ".more:hover{border-color:var(--accent);color:var(--accent)}",
    ".msg{padding:40px 16px;text-align:center;color:var(--muted)}",
    ".msg button{margin-top:10px;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer}",
    ".spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;margin:0 auto 10px;animation:sp .8s linear infinite}",
    "@keyframes sp{to{transform:rotate(360deg)}}",
    // the side panel (cart / sign in / my orders / order placed)
    ".veil{position:fixed;inset:0;background:rgba(17,24,39,.4);z-index:2147483000;display:none}",
    ".veil.open{display:block}",
    ".panel{position:fixed;top:0;right:0;bottom:0;width:420px;max-width:100%;background:#fff;z-index:2147483001;",
    "  box-shadow:-8px 0 30px rgba(0,0,0,.15);display:flex;flex-direction:column;transform:translateX(105%);transition:transform .2s ease;visibility:hidden}",
    ".panel.open{transform:none;visibility:visible}",
    ".ph{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--line)}",
    ".ph h3{margin:0;font-size:17px;flex:1}",
    ".x{width:34px;height:34px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:22px;color:var(--muted)}",
    ".x:hover{background:var(--soft)}",
    ".pb{flex:1;overflow:auto;padding:14px 16px}",
    ".pf{border-top:1px solid var(--line);padding:12px 16px;display:flex;flex-direction:column;gap:8px}",
    ".primary{height:42px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;width:100%}",
    ".primary[disabled]{opacity:.55;cursor:not-allowed}",
    ".ghost{height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:pointer;width:100%}",
    ".ghost:hover{border-color:var(--accent)}",
    ".link{border:0;background:none;color:var(--accent);cursor:pointer;padding:0}",
    ".link:hover{text-decoration:underline}",
    ".line{display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--soft)}",
    ".line .lp{width:56px;height:56px;flex:none;border-radius:8px;background:var(--soft);overflow:hidden;display:flex;align-items:center;justify-content:center}",
    ".line .lp img{width:100%;height:100%;object-fit:contain;background:#fff}",
    ".line .lp svg{width:28px;height:28px;color:#c4c9d1}",
    ".line .lb{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}",
    ".line .ln{font-size:13px;font-weight:600;overflow-wrap:anywhere}",
    ".line .lr{display:flex;align-items:center;gap:10px}",
    ".line .step{width:116px;height:30px}",
    ".line .step button{width:30px}",
    ".line.flag{background:#fef2f2;margin:0 -16px;padding:10px 16px}",
    ".warn{font-size:12px;color:var(--bad);font-weight:600}",
    ".err{background:#fef2f2;color:var(--bad);border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:10px}",
    ".note{background:#fffbeb;color:#92400e;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:12px}",
    ".sum{font-size:13px;color:var(--muted)}",
    ".who{background:var(--soft);border-radius:8px;padding:8px 10px;font-size:13px;margin:12px 0}",
    ".fl{display:block;font-size:12px;font-weight:600;color:var(--muted);margin:10px 0 4px}",
    ".in{width:100%;height:38px;border:1px solid var(--line);border-radius:8px;padding:0 10px;outline:none;background:#fff}",
    ".in:focus{border-color:var(--accent)}",
    "textarea.in{height:70px;padding:8px 10px;resize:vertical}",
    ".row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
    ".row3{display:grid;grid-template-columns:1.4fr .8fr 1fr;gap:8px}",
    ".addr{border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;gap:10px;align-items:flex-start;font-size:13px}",
    ".addr .av{flex:1;min-width:0;overflow-wrap:anywhere}",
    ".addr .av .sum{display:block}",
    ".fh{display:flex;align-items:baseline;justify-content:space-between;gap:8px}",
    ".fh .link{font-size:12px}",
    ".ok{text-align:center;padding:20px 4px}",
    ".ok .big{width:52px;height:52px;border-radius:50%;background:#dcfce7;color:var(--ok);display:flex;align-items:center;justify-content:center;margin:0 auto 10px;font-size:28px}",
    ".ok h4{margin:0 0 4px;font-size:18px}",
    ".ord{border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden}",
    ".ord > button{width:100%;border:0;background:#fff;text-align:left;padding:10px 12px;cursor:pointer;display:flex;flex-direction:column;gap:2px}",
    ".ord .t{display:flex;align-items:center;gap:8px;font-weight:700}",
    ".ord .d{font-size:12px;color:var(--muted)}",
    ".ord .ls{border-top:1px solid var(--soft);padding:6px 12px 10px;font-size:13px}",
    ".ord .ls div{display:flex;gap:8px;padding:3px 0}",
    ".ord .ls b{min-width:34px;text-align:right}",
    ".pill{font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;background:var(--soft);color:var(--muted)}",
    ".pill.new{background:#dbeafe;color:#1d4ed8}",
    ".pill.processing{background:#fef3c7;color:#92400e}",
    ".pill.completed{background:#dcfce7;color:#166534}",
    ".pill.cancelled{background:#f3f4f6;color:#6b7280}",
    ".root.sm .title{font-size:17px}",
    ".root.sm .search{flex:1 1 100%;order:3}",
    ".root.sm .acts{margin-left:auto}",
    ".root.sm .hbtn .lbl{display:none}",
    ".root.sm .tiles{grid-template-columns:repeat(2,minmax(0,1fr))}",
    ".root.sm .models{grid-template-columns:repeat(2,minmax(0,1fr))}",
    ".root.sm .cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}",
    ".root.sm .chips.scroll{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}",
    ".root.sm .chips.scroll::-webkit-scrollbar{display:none}",
    ".root.sm .filter{width:100%}",
    ".root.sm .seg{display:flex}",
    ".root.sm .seg button{flex:1;padding:6px 8px}",
    "@media (max-width:480px){.panel{width:100%}}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    // signed out: only the sign-in screen
    ".root.locked .search,.root.locked .acts,.root.locked .crumbs{display:none}",
    ".gate{max-width:400px;margin:20px auto;padding:22px 20px;border:1px solid var(--line);border-radius:14px;background:#fff}",
    ".gate h3{margin:0 0 4px;font-size:18px}",
    ".gate .lead{margin:0 0 14px;color:var(--muted);font-size:13px}",
    // 3D view of a model (models with a published 3D diagram)
    ".d3tag{display:inline-block;font-size:10px;font-weight:700;line-height:14px;color:var(--accent);border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:6px;vertical-align:1px}",
    ".chip[aria-pressed='true'] .d3tag{color:#fff}",
    ".seg.modes button{display:inline-flex;align-items:center;gap:6px}",
    ".seg.modes svg{width:15px;height:15px}",
    ".d3{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:12px;align-items:start}",
    ".d3main{min-width:0;display:flex;flex-direction:column;gap:8px}",
    ".d3stage{position:relative;height:520px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:radial-gradient(circle at 50% 40%,#fbfcfe,#e9eef4)}",
    ".d3host{position:absolute;inset:0}",
    ".d3over{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;padding:16px;color:var(--muted);background:rgba(248,250,252,.75)}",
    ".d3over[hidden]{display:none}",
    ".d3over .bar3{width:180px;height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin-top:6px}",
    ".d3over .bar3 i{display:block;height:100%;background:var(--accent);transition:width .2s}",
    ".d3over button{margin-top:8px;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 14px;cursor:pointer}",
    ".d3tip{position:absolute;pointer-events:none;background:#111827;color:#fff;font-size:12px;padding:3px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,calc(-100% - 12px));z-index:2}",
    ".d3tip[hidden]{display:none}",
    ".d3sel{position:absolute;left:10px;top:10px;max-width:calc(100% - 20px);background:rgba(255,255,255,.92);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 12px;font-size:12px;display:flex;align-items:center;gap:6px;box-shadow:0 2px 8px rgba(0,0,0,.06)}",
    ".d3sel[hidden]{display:none}",
    ".d3sel b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".d3sel button{border:0;background:var(--soft);border-radius:999px;width:22px;height:22px;cursor:pointer;line-height:1;flex:none}",
    ".d3hint{position:absolute;right:10px;bottom:8px;font-size:11px;color:var(--muted);pointer-events:none}",
    ".d3ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ".d3ctl label{font-size:12px;color:var(--muted);font-weight:600}",
    ".d3ctl input[type=range]{flex:1 1 140px;min-width:120px;accent-color:var(--accent)}",
    ".d3ctl button{height:30px;border:1px solid var(--line);background:#fff;border-radius:8px;padding:0 10px;cursor:pointer;font-size:12px}",
    ".d3ctl button:hover{border-color:var(--accent)}",
    ".d3note{font-size:11px;color:var(--muted)}",
    ".d3side{border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;max-height:600px;overflow:hidden;background:#fff}",
    ".d3side .sh{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:2px}",
    ".d3side .sh .t{font-weight:700;font-size:15px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
    ".d3side .sh .code{font-size:11px;font-weight:600;color:var(--muted)}",
    ".d3side .sb{overflow:auto;padding:6px;flex:1}",
    ".d3list button{width:100%;display:flex;align-items:center;gap:8px;border:0;background:none;padding:7px 8px;border-radius:8px;text-align:left;cursor:pointer}",
    ".d3list button:hover{background:var(--soft)}",
    ".d3list .no{font-size:11px;color:var(--muted);width:22px;flex:none}",
    ".d3list .pl{flex:1;min-width:0;display:flex;flex-direction:column}",
    ".d3list .pl small{font-size:11px;color:var(--muted)}",
    ".d3list .pc{font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;background:var(--soft);color:var(--muted);flex:none}",
    ".d3list .pc.has{background:#dbeafe;color:#1d4ed8}",
    ".d3list button.none .pl{opacity:.6}",
    ".d3items{display:flex;flex-direction:column;gap:6px}",
    ".d3items .card{flex-direction:row;border-radius:10px}",
    ".d3items .pic{width:76px;flex:none;aspect-ratio:auto;min-height:76px}",
    ".d3items .info{padding:8px 10px;gap:4px;min-width:0}",
    ".d3items .add,.d3items .step{height:30px}",
    ".d3items .step button{width:30px}",
    ".d3empty{padding:18px 10px;text-align:center;color:var(--muted);font-size:13px}",
    ".root.narrow3d .d3{grid-template-columns:minmax(0,1fr)}",
    ".root.narrow3d .d3stage{height:380px}",
    ".root.narrow3d .d3side{max-height:none}",
    ".root.narrow3d .d3side .sb{overflow:visible}",
    ".root.narrow3d .d3hint{display:none}",
    ".d3sel .go{display:none;width:auto;padding:0 8px;font-size:12px;color:var(--accent);background:none}",
    ".root.narrow3d .d3sel .go{display:block}",
    ".root.sm .d3stage{height:320px}",
    "@media (prefers-reduced-motion:reduce){.spin{animation:none}.panel{transition:none}}",
  ].join("\n");

  var ICON_SEARCH = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  var ICON_BOX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/></svg>';
  var ICON_CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.3 11.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.5-1.1L21 8H6"/></svg>';
  var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
  var ICON_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  var ICON_CUBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M3.5 7.25L12 12l8.5-4.75M12 12v9.5"/></svg>';

  // The 3D view's code (an ES module + three.js) loads only when a 3D view is
  // opened. Bump the ?v= when viewer3d.js changes — browsers cache it.
  var VIEWER_FILE = "viewer3d.js?v=2";
  function viewerUrl() {
    try {
      return new URL(VIEWER_FILE, SCRIPT && SCRIPT.src ? SCRIPT.src : location.href).href;
    } catch (e) {
      return VIEWER_FILE;
    }
  }
  var viewerModule = null;
  function loadViewer() {
    if (!viewerModule) {
      viewerModule = import(viewerUrl()).catch(function (e) {
        viewerModule = null;
        throw e;
      });
    }
    return viewerModule;
  }

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
  // localStorage can be missing or throw (private windows, blocked storage):
  // the widget then works for this visit only.
  function load(k) {
    try { return JSON.parse(window.localStorage.getItem(k) || "null"); } catch (e) { return null; }
  }
  function save(k, v) {
    try {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* this visit only */ }
  }
  function newId() {
    var a = "";
    for (var i = 0; i < 4; i++) a += Math.random().toString(36).slice(2, 8);
    return "co_" + Date.now().toString(36) + a;
  }
  function pic(imageId) {
    return imageId ? '<img loading="lazy" alt="" src="' + IMG_BASE + encodeURIComponent(imageId) + '/400x400">' : ICON_BOX;
  }
  function day(t) {
    try { return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return ""; }
  }

  function init(mount) {
    if (mount.shadowRoot) return;
    var apiBase = (mount.getAttribute("data-api-base") || scriptOrigin()).replace(/\/+$/, "");
    var key = mount.getAttribute("data-distributor-key") || "";
    var titleAttr = mount.getAttribute("data-title");
    var title = titleAttr == null ? "Order parts" : titleAttr;
    var accent = mount.getAttribute("data-accent");
    var store = "imobile-embed-ordering:" + key + ":";

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
      '<div class="acts">' +
      '<button type="button" class="hbtn acct" data-act="account">' + ICON_USER + '<span class="lbl">Sign in</span></button>' +
      '<button type="button" class="hbtn" data-act="cart" aria-label="Cart">' + ICON_CART + '<span class="lbl">Cart</span><span class="badge zero">0</span></button>' +
      "</div></div>" +
      '<nav class="crumbs" aria-label="Where you are"></nav>' +
      '<div class="body" aria-live="polite"></div>' +
      '<div class="veil" data-act="close"></div>' +
      '<aside class="panel" role="dialog" aria-modal="true" aria-label="Cart"><div class="ph"><h3></h3><button type="button" class="x" data-act="close" aria-label="Close">&times;</button></div><div class="pb"></div><div class="pf"></div></aside>' +
      "</div>";
    var root = shadow.querySelector(".root");
    if (accent) root.style.setProperty("--accent", accent);
    var crumbsEl = shadow.querySelector(".crumbs");
    var body = shadow.querySelector(".body");
    var searchBox = shadow.querySelector(".search");
    var input = searchBox.querySelector("input");
    var badge = shadow.querySelector(".badge");
    var acctLbl = shadow.querySelector(".acct .lbl");
    var veil = shadow.querySelector(".veil");
    var panel = shadow.querySelector(".panel");
    var panelTitle = panel.querySelector("h3");
    var panelBody = panel.querySelector(".pb");
    var panelFoot = panel.querySelector(".pf");

    var catalog = null;
    var partsCache = {};
    var searchCache = {};
    var view = { kind: "brands" };
    var beforeSearch = null;
    var searchTimer = null;
    var seq = 0; // drops answers that arrive after the view moved on

    // cart: [{ id, name, sku, quality, imageId, qty }] in the order added
    var cart = load(store + "cart") || [];
    if (!Array.isArray(cart)) cart = [];
    var checkoutId = load(store + "checkout") || newId(); // one id per cart content
    var flagged = {}; // itemId → true when the server said it can't be ordered now
    var token = load(store + "token") || "";
    var me = load(store + "me") || null;
    var known = {}; // itemId → part, from what has been shown
    var mode = ""; // which panel is open
    var afterSignIn = "";
    var draft = { note: "", address: null }; // checkout fields while typing
    var addrOpen = false; // the delivery address fields are shown only to change it
    // All / In stock / Out of stock — kept for the next visit
    var stockFilter = load(store + "stock");
    if (["all", "in", "out"].indexOf(stockFilter) < 0) stockFilter = "all";
    var STOCK_LABELS = { all: "All", "in": "In stock", out: "Out of stock" };
    var lastOrder = null;
    var myOrders = null;
    var openOrder = "";
    var busy = false;
    var panelError = "";
    var distName = ""; // the distributor, named on the sign-in screen
    var gateMsg = "";
    var gateBusy = false;
    // 3D view: which models have one (from the catalogue), each model's
    // diagram (parts + linked items), the downloaded files, the open view
    var diagrams = {}; // "brand|model" lower-case → true
    var d3Info = {}; // "brand|model" → diagram from /diagram3d
    var glbCache = []; // [{ k: id:v, buf }] newest last, 3 kept
    var v3 = null; // { ck, el, viewer, d, selected, status: loading|ready|error, msg, progress, hover }
    // Parts list first; "3D view" is a switch (user, 2026-11-06). The choice
    // holds while browsing this visit, not the next one.
    var viewMode = "list";

    function headers(json) {
      var h = { "X-Distributor-Key": key };
      if (json) h["Content-Type"] = "application/json";
      if (token) h.Authorization = "Bearer " + token;
      return h;
    }
    function api(path) {
      return fetch(apiBase + path, { credentials: "omit", headers: headers(false) }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j || j.success === false) {
            var e = new Error((j && j.message) || "HTTP " + r.status);
            e.status = r.status;
            throw e;
          }
          return j;
        });
      });
    }
    // POST / authed GET: resolves { status, j } — the caller reads the answer.
    function call(method, path, data) {
      return fetch(apiBase + path, {
        method: method,
        credentials: "omit",
        headers: headers(!!data),
        body: data ? JSON.stringify(data) : undefined,
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j || {} }; });
      });
    }

    function typeLabel(t) {
      return (catalog && catalog.typeLabels && catalog.typeLabels[t]) || t;
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
    function remember(list) {
      (list || []).forEach(function (p) { known[p.id] = p; });
    }

    // ── cart ──
    function lineOf(id) {
      for (var i = 0; i < cart.length; i++) if (cart[i].id === id) return cart[i];
      return null;
    }
    function units() {
      return cart.reduce(function (s, l) { return s + l.qty; }, 0);
    }
    function saveCart() {
      checkoutId = newId(); // new content → a new order id
      save(store + "cart", cart);
      save(store + "checkout", checkoutId);
      paintBadge();
    }
    function setQty(id, qty) {
      qty = Math.floor(Number(qty));
      if (!isFinite(qty)) return;
      var l = lineOf(id);
      if (qty <= 0) {
        if (l) cart.splice(cart.indexOf(l), 1);
        delete flagged[id];
      } else {
        qty = Math.min(qty, MAX_QTY);
        if (l) l.qty = qty;
        else {
          var p = known[id];
          if (!p || !p.inStock) return;
          cart.push({ id: p.id, name: p.name, sku: p.sku, quality: p.quality, imageId: p.imageId, qty: qty });
        }
      }
      saveCart();
      paintCards(id);
      if (mode === "cart") renderPanel();
    }
    function paintBadge() {
      var n = units();
      badge.textContent = n > 999 ? "999+" : String(n);
      badge.classList.toggle("zero", !n);
    }
    function stepper(id, qty, small) {
      return '<div class="step"><button type="button" data-act="dec" data-id="' + esc(id) + '" aria-label="One less">−</button>' +
        '<input type="number" min="0" max="' + MAX_QTY + '" inputmode="numeric" value="' + qty + '" data-qty="' + esc(id) + '" aria-label="Quantity">' +
        '<button type="button" data-act="inc" data-id="' + esc(id) + '" aria-label="One more">+</button></div>';
    }
    function buyHtml(p) {
      var l = lineOf(p.id);
      if (!p.inStock) return l ? '<div class="warn">In your cart — out of stock now</div>' : '<button type="button" class="add" disabled>Out of stock</button>';
      return l ? stepper(p.id, l.qty) : '<button type="button" class="add" data-act="add" data-id="' + esc(p.id) + '">Add to cart</button>';
    }
    // redraw one part's cards (keeps the page and its scroll as they are)
    function paintCards(id) {
      var cards = body.querySelectorAll('.card[data-id="' + (window.CSS && window.CSS.escape ? window.CSS.escape(id) : id) + '"]');
      for (var i = 0; i < cards.length; i++) {
        var p = known[id];
        if (!p) continue;
        cards[i].classList.toggle("incart", !!lineOf(id));
        cards[i].querySelector(".buy").innerHTML = buyHtml(p);
      }
    }

    // ── rendering ──
    function message(html, retry) {
      drop3d();
      body.innerHTML = '<div class="msg">' + html + (retry ? '<br><button type="button" data-act="retry">Try again</button>' : "") + "</div>";
    }
    function loading() {
      drop3d();
      body.innerHTML = '<div class="msg"><div class="spin"></div>Loading…</div>';
    }

    function renderCrumbs() {
      var parts = [];
      var btn = function (label, act) {
        return '<button type="button" data-act="' + act + '">' + esc(label) + "</button>";
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
          esc(m.name) + d3Tag(view.brand.name, m.name) + '</div><div class="c">' + plural(m.parts, "part") + "</div></button>";
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

    // A part: photo, name, SKU / quality, stock, and Add / quantity. No link
    // out — the widget lives on the distributor's website.
    function card(p) {
      var inCart = !!lineOf(p.id);
      return '<div class="card' + (p.inStock ? "" : " out") + (inCart ? " incart" : "") + '" data-id="' + esc(p.id) + '">' +
        '<div class="pic">' + pic(p.imageId) + "</div>" +
        '<div class="info"><div class="name">' + esc(p.name) + "</div>" +
        '<div class="meta">' + (p.sku ? "<span>SKU " + esc(p.sku) + "</span>" : "") +
        (p.quality ? '<span class="tag">' + esc(p.quality) + "</span>" : "") + "</div>" +
        '<div class="stock ' + (p.inStock ? "yes" : "no") + '">' + (p.inStock ? "In stock" : "Out of stock") + "</div>" +
        '<div class="buy">' + buyHtml(p) + "</div></div></div>";
    }

    // The stock switch; counts only where the whole list is known (a model / the tools).
    function stockSeg(counts) {
      return '<div class="seg" role="group" aria-label="Stock">' + ["all", "in", "out"].map(function (k) {
        return '<button type="button" data-act="pick-stock" data-stock="' + k + '" aria-pressed="' + (stockFilter === k) + '">' +
          STOCK_LABELS[k] + (counts ? '<span class="k">' + counts[k] + "</span>" : "") + "</button>";
      }).join("") + "</div>";
    }
    function byStock(list) {
      if (stockFilter === "in") return list.filter(function (p) { return p.inStock; });
      if (stockFilter === "out") return list.filter(function (p) { return !p.inStock; });
      return list;
    }

    // ── 3D view ──
    function hasDiagram(brand, model) {
      return !!diagrams[(brand + "|" + model).toLowerCase()];
    }
    function d3Tag(brand, model) {
      return hasDiagram(brand, model) ? '<span class="d3tag" title="3D view">3D</span>' : "";
    }
    function is3d() {
      return view.kind === "model" && viewMode === "3d" && hasDiagram(view.brand.name, view.model.name);
    }
    // Parts list | 3D view, on models that have a 3D diagram
    function modeSeg() {
      if (view.kind !== "model" || !hasDiagram(view.brand.name, view.model.name)) return "";
      var b = function (m, icon, label) {
        return '<button type="button" data-act="view-mode" data-mode="' + m + '" aria-pressed="' + (viewMode === m) + '">' + icon + label + "</button>";
      };
      return '<div class="seg modes" role="group" aria-label="View">' + b("list", ICON_LIST, "Parts list") + b("3d", ICON_CUBE, "3D view") + "</div>";
    }
    function drop3d() {
      if (!v3) return;
      if (v3.viewer) {
        try { v3.viewer.dispose(); } catch (e) { /* already gone */ }
      }
      v3 = null;
    }
    function d3Part(code) {
      var ps = (v3 && v3.d && v3.d.parts) || [];
      for (var i = 0; i < ps.length; i++) if (ps[i].code === code) return ps[i];
      return null;
    }
    function render3d() {
      var ck = view.brand.name + "|" + view.model.name;
      if (v3 && v3.ck === ck && v3.el && body.contains(v3.el)) return paint3d();
      drop3d();
      body.innerHTML = modeSeg() +
        '<div class="d3"><div class="d3main">' +
        '<div class="d3stage"><div class="d3host"></div>' +
        '<div class="d3sel" hidden><b></b><button type="button" class="go" data-act="d3-go">See parts ↓</button><button type="button" data-act="d3-all" aria-label="Show all parts">&times;</button></div>' +
        '<div class="d3tip" hidden></div><div class="d3over"></div>' +
        '<div class="d3hint">Drag to turn · scroll to zoom · click a part</div></div>' +
        '<div class="d3ctl"><label for="d3-sep">Separate</label>' +
        '<input id="d3-sep" class="d3range" type="range" min="0" max="100" step="1" value="80" aria-label="Separate the parts">' +
        '<button type="button" data-act="d3-exp" data-t="0">Assembled</button>' +
        '<button type="button" data-act="d3-exp" data-t="1">Exploded</button>' +
        '<button type="button" data-act="d3-reset">Reset view</button></div>' +
        '<div class="d3note">Illustrative 3D model — shapes and positions are approximate, not a repair guide.</div>' +
        '</div><aside class="d3side" aria-label="Parts in the 3D view"></aside></div>';
      v3 = { ck: ck, el: body.querySelector(".d3"), viewer: null, d: d3Info[ck] || null, selected: "", status: "loading", msg: "", progress: 0 };
      paint3d();
      load3d(v3, view.brand.name, view.model.name);
    }
    function paint3d() {
      paint3dOver();
      paint3dSide();
    }
    function paint3dOver() {
      if (!v3) return;
      var over = v3.el.querySelector(".d3over");
      if (v3.status === "ready") {
        over.hidden = true;
        over.innerHTML = "";
      } else if (v3.status === "error") {
        over.hidden = false;
        over.innerHTML = "<div>" + esc(v3.msg) + "</div>" + (v3.retry ? '<button type="button" data-act="d3-retry">Try again</button>' : "");
      } else {
        over.hidden = false;
        var pct = Math.round(v3.progress * 100);
        over.innerHTML = '<div class="spin"></div><div>Loading the 3D model…</div>' +
          '<div class="bar3" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + pct + '%"></i></div>';
      }
      var sel = v3.el.querySelector(".d3sel");
      var p = v3.selected ? d3Part(v3.selected) : null;
      sel.hidden = !p;
      if (p) sel.querySelector("b").textContent = p.label + " · " + plural(p.items.length, "part");
    }
    function paint3dSide() {
      if (!v3) return;
      var side = v3.el.querySelector(".d3side");
      var d = v3.d;
      if (!d) {
        side.innerHTML = '<div class="d3empty">Loading the parts…</div>';
        return;
      }
      var p = v3.selected ? d3Part(v3.selected) : null;
      if (p) {
        remember(p.items);
        var nIn = p.items.filter(function (x) { return x.inStock; }).length;
        side.innerHTML = '<div class="sh"><button type="button" class="link" data-act="d3-all" style="align-self:flex-start;font-size:12px">← All parts</button>' +
          '<div class="t">' + esc(p.label) + '<span class="code">' + esc(p.code) + "</span></div>" +
          '<div class="sum">' + (p.items.length ? plural(p.items.length, "part") + " · " + nIn + " in stock" : "") + "</div></div>" +
          '<div class="sb">' + (p.items.length
            ? '<div class="d3items">' + p.items.map(card).join("") + "</div>"
            : '<div class="d3empty">We don’t list a part for the ' + esc(p.label.toLowerCase()) + " yet.</div>") + "</div>";
        return;
      }
      var linked = d.parts.filter(function (x) { return x.items.length; }).length;
      side.innerHTML = '<div class="sh"><div class="t">Parts in this model</div><div class="sum">' + plural(d.parts.length, "part") +
        " · " + linked + " with parts to order</div></div>" +
        '<div class="sb d3list">' + d.parts.map(function (x, i) {
          return '<button type="button" data-act="d3-part" data-code="' + esc(x.code) + '"' + (x.items.length ? "" : ' class="none"') + ">" +
            '<span class="no">' + (i < 9 ? "0" : "") + (i + 1) + "</span>" +
            '<span class="pl">' + esc(x.label) + "<small>" + esc(x.code) + "</small></span>" +
            '<span class="pc' + (x.items.length ? " has" : "") + '">' + (x.items.length || "–") + "</span></button>";
        }).join("") + "</div>";
    }
    function select3d(code) {
      if (!v3) return;
      v3.selected = code && d3Part(code) ? code : "";
      if (v3.viewer) v3.viewer.select(v3.selected);
      paint3d();
      var sb = v3.el.querySelector(".d3side .sb");
      if (sb) sb.scrollTop = 0;
    }
    // the file, downloaded once per visit (3 kept); progress from the real size
    function fetchGlb(d, s) {
      var k = d.id + ":" + d.v;
      for (var i = 0; i < glbCache.length; i++) if (glbCache[i].k === k) return Promise.resolve(glbCache[i].buf);
      return fetch(apiBase + "/widget/embed-ordering/diagram3d/" + encodeURIComponent(d.id) + "/model.glb?v=" + encodeURIComponent(d.v), {
        credentials: "omit",
        headers: headers(false),
      }).then(function (r) {
        if (!r.ok) {
          var e = new Error("HTTP " + r.status);
          e.status = r.status;
          throw e;
        }
        if (!r.body || !r.body.getReader || !d.bytes) return r.arrayBuffer();
        var reader = r.body.getReader();
        var chunks = [];
        var got = 0;
        var last = 0;
        return (function pump() {
          return reader.read().then(function (x) {
            if (x.done) {
              var out = new Uint8Array(got);
              var at = 0;
              chunks.forEach(function (c) { out.set(c, at); at += c.length; });
              return out.buffer;
            }
            chunks.push(x.value);
            got += x.value.length;
            if (v3 === s && Date.now() - last > 120) {
              last = Date.now();
              s.progress = Math.min(1, got / d.bytes);
              paint3dOver();
            }
            return pump();
          });
        })();
      }).then(function (buf) {
        glbCache.push({ k: k, buf: buf });
        if (glbCache.length > 3) glbCache.shift();
        return buf;
      });
    }
    function load3d(s, brandName, modelName) {
      var gone = function () { return v3 !== s; };
      var info = s.d ? Promise.resolve(s.d) : api("/widget/embed-ordering/diagram3d?brand=" + encodeURIComponent(brandName) + "&model=" + encodeURIComponent(modelName))
        .then(function (j) { d3Info[s.ck] = j.diagram; return j.diagram; });
      info
        .then(function (d) {
          if (gone()) return null;
          s.d = d;
          d.parts.forEach(function (p) { remember(p.items); });
          paint3dSide();
          return Promise.all([loadViewer(), fetchGlb(d, s)]);
        })
        .then(function (r) {
          if (!r || gone()) return null;
          var mod = r[0];
          if (mod.webglAvailable && !mod.webglAvailable()) {
            var e = new Error("webgl");
            e.webgl = true;
            throw e;
          }
          var host = s.el.querySelector(".d3host");
          var tip = s.el.querySelector(".d3tip");
          var range = s.el.querySelector(".d3range");
          s.viewer = mod.createViewer(host, {
            accent: getComputedStyle(root).getPropertyValue("--accent").trim() || "#0b7fd4",
            label: view.model.name + " in 3D — drag to turn, scroll or pinch to zoom, click a part",
            onSelect: function (code) {
              if (gone()) return;
              s.selected = code;
              paint3d();
            },
            onHover: function (p, at) {
              if (gone()) return;
              if (!p || !at) { tip.hidden = true; return; }
              var rect = s.el.querySelector(".d3stage").getBoundingClientRect();
              var part = d3Part(p.code);
              tip.textContent = p.label + (part ? " · " + plural(part.items.length, "part") : "");
              tip.style.left = (at.x - rect.left) + "px";
              tip.style.top = (at.y - rect.top) + "px";
              tip.hidden = false;
            },
            onExploded: function (t) {
              if (!gone() && range) range.value = String(Math.round(t * 100));
            },
          });
          var faces = {};
          s.d.parts.forEach(function (p) { if (p.face) faces[p.code] = { face: p.face }; });
          s.viewer.setPartOptions(faces);
          return s.viewer.load(r[1]);
        })
        .then(function (res) {
          if (!res || gone()) return;
          s.status = "ready";
          if (s.selected) s.viewer.select(s.selected);
          paint3dOver();
        })
        .catch(function (e) {
          if (e && e.status === 401) return expired();
          if (gone()) return;
          s.status = "error";
          s.retry = !(e && (e.webgl || e.status === 404));
          s.msg = e && e.webgl
            ? "This browser can’t show 3D. Use the parts list instead."
            : e && e.status === 404 ? "There’s no 3D view for this model right now." : "The 3D view couldn’t be loaded.";
          if (e && !e.status && !e.webgl && /webgl/i.test(String(e.message))) {
            s.msg = "This browser can’t show 3D. Use the parts list instead.";
            s.retry = false;
          }
          if (s.viewer) {
            try { s.viewer.dispose(); } catch (x) { /* ignore */ }
            s.viewer = null;
          }
          paint3dOver();
        });
    }

    function renderParts() {
      if (is3d()) return render3d();
      drop3d();
      var all = view.items || [];
      var seg = modeSeg();
      if (!all.length) {
        body.innerHTML = seg + '<div class="msg">No parts listed for this model yet.</div>';
        return;
      }
      var nIn = all.filter(function (p) { return p.inStock; }).length;
      var items = byStock(all);
      var html = seg + stockSeg({ all: all.length, "in": nIn, out: all.length - nIn });
      if (!items.length) {
        body.innerHTML = html + '<div class="msg">No ' + (stockFilter === "in" ? "in-stock" : "out-of-stock") + " parts here. " +
          '<button type="button" data-act="pick-stock" data-stock="all">Show all</button></div>';
        return;
      }
      var types = [];
      var byType = {};
      items.forEach(function (p) {
        if (!byType[p.type]) { byType[p.type] = []; types.push(p.type); }
        byType[p.type].push(p);
      });
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
      if (!r.models.length && !r.items.length && stockFilter === "all") return message("Nothing matches “" + esc(view.q) + "”. Try a model name like “iPhone 13” or a part like “battery”.");
      var html = "";
      if (r.models.length) {
        html += '<div class="section">Models</div><div class="chips">';
        r.models.forEach(function (m) {
          html += '<button type="button" class="chip" data-act="search-model" data-brand="' + esc(m.brand) + '" data-model="' + esc(m.name) + '">' +
            esc(m.name) + d3Tag(m.brand, m.name) + '<span class="k">' + m.parts + "</span></button>";
        });
        html += "</div>";
      }
      var what = stockFilter === "all" ? "" : (stockFilter === "in" ? " in stock" : " out of stock");
      html += '<div class="section">Parts' + what + ' <span class="count">' +
        (r.total > r.items.length ? "— first " + r.items.length + " of " + r.total + ", add a word to narrow it" : "— " + r.total) + "</span></div>";
      html += stockSeg(null);
      if (r.items.length) html += '<div class="grid cards">' + r.items.map(card).join("") + "</div>";
      else html += '<div class="msg">No parts' + what + " match “" + esc(view.q) + "”.</div>";
      body.innerHTML = html;
    }

    function render() {
      renderCrumbs();
      if (!catalog) return;
      if (!is3d()) drop3d();
      if (view.kind === "brands") renderBrands();
      else if (view.kind === "brand") renderBrand();
      else if (view.kind === "search") renderSearch();
      else if (is3d()) render3d(); // the 3D view doesn't wait for the parts list
      else if (view.items) renderParts();
      else loading();
    }

    // ── the side panel ──
    function addr() {
      return draft.address || (me && me.address) || { line1: "", line2: "", city: "", state: "", postcode: "" };
    }
    function paintAccount() {
      acctLbl.textContent = me ? (me.name || me.email || "My account") : "Sign in";
    }
    function openPanel(m) {
      mode = m;
      panelError = "";
      veil.classList.add("open");
      panel.classList.add("open");
      renderPanel();
      if (m === "orders") loadOrders();
      setTimeout(function () {
        var f = panel.querySelector(".pb input, .pb button, .x");
        if (f) f.focus();
      }, 60);
    }
    function closePanel() {
      mode = "";
      veil.classList.remove("open");
      panel.classList.remove("open");
    }
    function addrText(a) {
      var town = [a.city, a.state, a.postcode].filter(Boolean).join(" ");
      return [a.line1, a.line2, town].filter(Boolean);
    }
    // Deliver to: the address on file as one short block with "Change"; the
    // fields open only to change it (or when there is no address yet).
    function deliverHtml(a) {
      var lines = addrText(a);
      if (!addrOpen && lines.length) {
        return '<div class="fl">Deliver to</div><div class="addr"><div class="av">' + esc(lines[0]) +
          (lines.length > 1 ? '<span class="sum">' + esc(lines.slice(1).join(", ")) + "</span>" : "") +
          '</div><button type="button" class="link" data-act="addr-edit">Change</button></div>';
      }
      return '<div class="fl fh"><span>Deliver to</span>' +
        (lines.length ? '<button type="button" class="link" data-act="addr-done">Done</button>' : "") + "</div>" +
        '<input class="in" data-a="line1" placeholder="Street address" maxlength="200" value="' + esc(a.line1) + '" style="margin-bottom:6px">' +
        '<input class="in" data-a="line2" placeholder="Unit, building (optional)" maxlength="200" value="' + esc(a.line2) + '" style="margin-bottom:6px">' +
        '<div class="row3"><input class="in" data-a="city" placeholder="Suburb" maxlength="100" value="' + esc(a.city) + '">' +
        '<input class="in" data-a="state" placeholder="State" maxlength="60" value="' + esc(a.state) + '">' +
        '<input class="in" data-a="postcode" placeholder="Postcode" maxlength="20" value="' + esc(a.postcode) + '"></div>';
    }
    function errHtml() {
      return panelError ? '<div class="err" role="alert">' + esc(panelError) + "</div>" : "";
    }

    function renderPanel() {
      if (!mode) return;
      var h = "", f = "";
      if (mode === "cart") {
        panelTitle.textContent = "Your cart";
        if (!cart.length) {
          h = errHtml() + '<div class="msg">Your cart is empty.<br>Add parts with “Add to cart”.</div>';
          f = '<button type="button" class="ghost" data-act="close">Continue browsing</button>';
        } else {
          h += errHtml();
          cart.forEach(function (l) {
            h += '<div class="line' + (flagged[l.id] ? " flag" : "") + '"><div class="lp">' + pic(l.imageId) + "</div>" +
              '<div class="lb"><div class="ln">' + esc(l.name) + "</div>" +
              '<div class="meta">' + (l.sku ? "<span>SKU " + esc(l.sku) + "</span>" : "") + (l.quality ? '<span class="tag">' + esc(l.quality) + "</span>" : "") + "</div>" +
              (flagged[l.id] ? '<div class="warn">Out of stock now — please remove it</div>' : "") +
              '<div class="lr">' + stepper(l.id, l.qty, true) + '<button type="button" class="link" data-act="remove" data-id="' + esc(l.id) + '">Remove</button></div>' +
              "</div></div>";
          });
          h += '<div class="sum" style="margin-top:10px">' + plural(cart.length, "part") + " · " + plural(units(), "unit") + "</div>";
          if (me) {
            var a = addr();
            h += '<div class="who">Ordering as <b>' + esc(me.name || me.email) + "</b>" + (me.name ? " (" + esc(me.email) + ")" : "") +
              ' · <button type="button" class="link" data-act="signout">Not you?</button></div>' +
              deliverHtml(a) +
              '<label class="fl" for="ck-note">Note (optional)</label><textarea id="ck-note" class="in" data-f="note" maxlength="1000">' + esc(draft.note) + "</textarea>";
            f = '<button type="button" class="primary" data-act="place"' + (busy ? " disabled" : "") + ">" + (busy ? "Placing order…" : "Place order") + "</button>" +
              '<div class="sum">No payment now — the order goes to us to confirm.</div>';
          } else {
            f = '<button type="button" class="primary" data-act="signin-cart">Sign in again to place your order</button>';
          }
        }
      } else if (mode === "orders") {
        panelTitle.textContent = "My orders";
        h = errHtml() + '<div class="who">Signed in as <b>' + esc(me ? me.name || me.email : "") + "</b>" + (me && me.name ? " (" + esc(me.email) + ")" : "") + "</div>";
        if (!myOrders) h += '<div class="msg"><div class="spin"></div>Loading…</div>';
        else if (!myOrders.length) h += '<div class="msg">No orders yet.</div>';
        else {
          myOrders.forEach(function (o) {
            var isOpen = openOrder === o.orderNo;
            h += '<div class="ord"><button type="button" data-act="toggle-order" data-no="' + esc(o.orderNo) + '" aria-expanded="' + isOpen + '">' +
              '<span class="t">' + esc(o.orderNo) + ' <span class="pill ' + esc(o.status) + '">' + esc(o.statusLabel || o.status) + "</span></span>" +
              '<span class="d">' + day(o.createdAt) + " · " + plural(o.units, "unit") + (o.reference ? " · Ref " + esc(o.reference) : "") + "</span></button>";
            if (isOpen) {
              h += '<div class="ls">' + o.lines.map(function (l) {
                return "<div><b>" + l.qty + "×</b><span>" + esc(l.name) + (l.sku ? ' <span class="sum">SKU ' + esc(l.sku) + "</span>" : "") + "</span></div>";
              }).join("") + "</div>";
            }
            h += "</div>";
          });
        }
        f = '<button type="button" class="ghost" data-act="signout">Sign out</button>';
      } else if (mode === "done") {
        panelTitle.textContent = "Order placed";
        var o = lastOrder;
        h = '<div class="ok"><div class="big">✓</div><h4>Thank you!</h4><div>Your order <b>' + esc(o.orderNo) + "</b> has been sent.</div>" +
          '<div class="sum" style="margin-top:6px">' + plural(o.lines.length, "part") + " · " + plural(o.units, "unit") +
          (o.reference ? " · Ref " + esc(o.reference) : "") + "</div>" +
          '<div class="sum" style="margin-top:10px">We’ll confirm it and be in touch.</div></div>';
        f = '<button type="button" class="ghost" data-act="my-orders">My orders</button><button type="button" class="primary" data-act="close">Continue browsing</button>';
      }
      panelBody.innerHTML = h;
      panelFoot.innerHTML = f;
      panelFoot.style.display = f ? "" : "none";
      panel.setAttribute("aria-label", panelTitle.textContent);
    }

    // ── sign-in screen: nothing of the catalogue shows before signing in ──
    function renderGate(email) {
      body.innerHTML = '<div class="gate"><h3>Sign in to see parts and order</h3>' +
        '<p class="lead">Enter the email address your account is registered with.</p>' +
        (gateMsg ? '<div class="err" role="alert">' + esc(gateMsg) + "</div>" : "") +
        '<div class="note">Demo sign-in: your email address is all you need for now.</div>' +
        '<form data-form="signin"><label class="fl" for="si-email">Email</label>' +
        '<input id="si-email" class="in" type="email" autocomplete="email" required maxlength="140" placeholder="you@business.com" value="' + esc(email || "") + '">' +
        '<div style="height:12px"></div><button type="submit" class="primary"' + (gateBusy ? " disabled" : "") + ">" +
        (gateBusy ? "Signing in…" : "Sign in") + "</button></form>" +
        '<p class="sum" style="margin:12px 0 0">Your account is set up by ' + esc(distName || "the business") + ". No account yet? Please ask them.</p></div>";
    }
    function showGate(msg) {
      closePanel();
      ++seq; // drop answers still on their way
      drop3d();
      catalog = null;
      partsCache = {};
      searchCache = {};
      d3Info = {};
      diagrams = {};
      known = {};
      view = { kind: "brands" };
      input.value = "";
      searchBox.classList.remove("has");
      root.classList.add("locked");
      crumbsEl.innerHTML = "";
      gateMsg = msg || "";
      renderGate("");
    }
    function signedOut(msg) {
      token = "";
      me = null;
      save(store + "token", null);
      save(store + "me", null);
      myOrders = null;
      paintAccount();
      showGate(msg);
    }
    // a refused session on the way (expired, or the account was closed)
    function expired() {
      signedOut("Please sign in again.");
    }

    function signIn(email) {
      if (gateBusy) return;
      gateBusy = true;
      gateMsg = "";
      renderGate(email);
      call("POST", "/widget/embed-ordering/login", { email: email })
        .then(function (r) {
          gateBusy = false;
          if (r.status !== 200 || !r.j.token) {
            gateMsg = r.j.message || "Couldn’t sign in. Please try again.";
            renderGate(email);
            var el = body.querySelector("#si-email");
            if (el) el.focus();
            return;
          }
          token = r.j.token;
          me = r.j.customer || null;
          save(store + "token", token);
          save(store + "me", me);
          draft.address = null;
          addrOpen = false;
          gateMsg = "";
          paintAccount();
          loadCatalog();
        })
        .catch(function () {
          gateBusy = false;
          gateMsg = "Couldn’t reach the server. Please try again.";
          renderGate(email);
        });
    }

    // Signing out also empties the cart, so the next person on this
    // computer doesn't see it.
    function signOut() {
      var t = token;
      cart = [];
      flagged = {};
      draft = { note: "", address: null };
      saveCart();
      if (t) fetch(apiBase + "/widget/embed-ordering/logout", { method: "POST", credentials: "omit", headers: { "X-Distributor-Key": key, Authorization: "Bearer " + t } }).catch(function () {});
      signedOut();
    }

    function loadOrders() {
      myOrders = null;
      renderPanel();
      call("GET", "/widget/embed-ordering/orders")
        .then(function (r) {
          if (r.status === 401) { afterSignIn = "orders"; return expired(); }
          if (r.status !== 200) { panelError = r.j.message || "Couldn’t load your orders."; myOrders = []; return renderPanel(); }
          myOrders = r.j.orders || [];
          if (mode === "orders") renderPanel();
        })
        .catch(function () {
          panelError = "Couldn’t reach the server. Please try again.";
          myOrders = [];
          renderPanel();
        });
    }

    function placeOrder() {
      if (busy || !cart.length) return;
      var flaggedNow = cart.filter(function (l) { return flagged[l.id]; });
      if (flaggedNow.length) {
        panelError = "Please remove the parts marked out of stock first.";
        return renderPanel();
      }
      busy = true;
      panelError = "";
      renderPanel();
      call("POST", "/widget/embed-ordering/orders", {
        clientOrderId: checkoutId,
        lines: cart.map(function (l) { return { itemId: l.id, qty: l.qty }; }),
        note: draft.note,
        deliveryAddress: addr(),
      })
        .then(function (r) {
          busy = false;
          if (r.status === 200 && r.j.order) {
            lastOrder = r.j.order;
            cart = [];
            flagged = {};
            draft = { note: "", address: null };
            addrOpen = false;
            myOrders = null;
            saveCart();
            render();
            return openPanel("done");
          }
          if (r.status === 401) {
            afterSignIn = "cart";
            return signedOut("Please sign in again to place your order — your cart is kept.");
          }
          if (r.status === 409 && r.j.outOfStock) {
            r.j.outOfStock.forEach(function (id) {
              flagged[id] = true;
              if (known[id]) { known[id].inStock = false; paintCards(id); }
            });
          }
          panelError = r.j.message || "The order couldn’t be placed. Please try again.";
          renderPanel();
        })
        .catch(function () {
          busy = false;
          panelError = "Couldn’t reach the server. Your cart is kept — please try again.";
          renderPanel();
        });
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
      var ck = b.name + "|" + hit.model.name;
      go({ kind: "model", brand: b, series: hit.series, model: hit.model, items: partsCache[ck] || null, type: "", sub: "" });
      if (partsCache[ck]) return;
      api("/widget/embed-ordering/parts?brand=" + encodeURIComponent(b.name) + "&model=" + encodeURIComponent(hit.model.name))
        .then(function (j) {
          partsCache[ck] = j.items || [];
          remember(partsCache[ck]);
          if (mine === seq) { view.items = partsCache[ck]; render(); }
        })
        .catch(function (e) {
          if (e && e.status === 401) return expired();
          // the 3D view carries on without the list
          if (mine === seq && !is3d()) message("Couldn’t load the parts for this model.", true);
        });
    }
    function openTools() {
      var mine = ++seq;
      go({ kind: "tools", items: partsCache.tools || null, type: "", sub: "" });
      if (partsCache.tools) return;
      api("/widget/embed-ordering/parts?tools=1")
        .then(function (j) {
          partsCache.tools = j.items || [];
          remember(partsCache.tools);
          if (mine === seq) { view.items = partsCache.tools; render(); }
        })
        .catch(function (e) {
          if (e && e.status === 401) return expired();
          if (mine === seq) message("Couldn’t load the tools.", true);
        });
    }
    function runSearch(q) {
      if (view.kind !== "search") beforeSearch = view;
      var mine = ++seq;
      var sk = q.toLowerCase() + "|" + stockFilter;
      go({ kind: "search", q: q, result: searchCache[sk] || null }, true);
      if (searchCache[sk]) return;
      api("/widget/embed-ordering/search?q=" + encodeURIComponent(q) + (stockFilter !== "all" ? "&stock=" + stockFilter : ""))
        .then(function (j) {
          searchCache[sk] = j;
          remember(j.items);
          if (mine === seq) { view.result = j; render(); }
        })
        .catch(function (e) {
          if (e && e.status === 401) return expired();
          if (mine === seq) message("Search isn’t available right now.", true);
        });
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
      var id = el.getAttribute("data-id");
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
      else if (act === "pick-stock") {
        stockFilter = el.getAttribute("data-stock") || "all";
        save(store + "stock", stockFilter);
        if (view.kind === "search") runSearch(view.q);
        else { view.type = ""; view.sub = ""; view.shown = PAGE; render(); }
      }
      else if (act === "pick-sub") { view.sub = el.getAttribute("data-sub"); view.shown = PAGE; render(); }
      else if (act === "more") { view.shown = (view.shown || PAGE) + PAGE; render(); }
      // 3D view
      else if (act === "view-mode") {
        viewMode = el.getAttribute("data-mode") === "3d" ? "3d" : "list";
        render();
      }
      else if (act === "d3-part") select3d(el.getAttribute("data-code"));
      else if (act === "d3-all") select3d("");
      else if (act === "d3-exp") {
        var t3 = Number(el.getAttribute("data-t")) || 0;
        if (v3 && v3.viewer) v3.viewer.setExploded(t3);
        var rg = body.querySelector(".d3range");
        if (rg) rg.value = String(Math.round(t3 * 100));
      }
      else if (act === "d3-reset") { if (v3 && v3.viewer) v3.viewer.reset(); }
      else if (act === "d3-go") { var sd = body.querySelector(".d3side"); if (sd) sd.scrollIntoView({ behavior: "smooth", block: "start" }); }
      else if (act === "d3-retry") { drop3d(); render(); }
      else if (act === "retry") {
        if (!catalog) start();
        else if (view.kind === "model") openModel(view.brand, view.model.name);
        else if (view.kind === "tools") openTools();
        else if (view.kind === "search") runSearch(view.q);
        else render();
      }
      // cart
      else if (act === "add") setQty(id, 1);
      else if (act === "inc") { var li = lineOf(id); setQty(id, (li ? li.qty : 0) + 1); }
      else if (act === "dec") { var ld = lineOf(id); if (ld) setQty(id, ld.qty - 1); }
      else if (act === "remove") setQty(id, 0);
      else if (act === "cart") openPanel("cart");
      else if (act === "account") { if (me) openPanel("orders"); else showGate(); }
      else if (act === "signin-cart") { afterSignIn = "cart"; signedOut(); }
      else if (act === "signout") signOut();
      else if (act === "place") placeOrder();
      else if (act === "addr-edit") {
        addrOpen = true;
        renderPanel();
        var first = panel.querySelector('[data-a="line1"]');
        if (first) first.focus();
      }
      else if (act === "addr-done") { addrOpen = false; renderPanel(); }
      else if (act === "my-orders") openPanel("orders");
      else if (act === "toggle-order") { var no = el.getAttribute("data-no"); openOrder = openOrder === no ? "" : no; renderPanel(); }
      else if (act === "close") closePanel();
    });
    shadow.addEventListener("submit", function (e) {
      if (!e.target || e.target.getAttribute("data-form") !== "signin") return;
      e.preventDefault();
      var el = e.target.querySelector("#si-email");
      var email = el ? el.value.trim() : "";
      if (!email) { if (el) el.focus(); return; }
      signIn(email);
    });
    // typed quantities (card or cart), checkout fields, the model filter
    shadow.addEventListener("change", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-qty") != null) {
        var v = t.value === "" ? 0 : Number(t.value);
        setQty(t.getAttribute("data-qty"), v);
      }
    });
    shadow.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.classList && t.classList.contains("d3range")) {
        if (v3 && v3.viewer) v3.viewer.setExploded(Number(t.value) / 100);
        return;
      }
      if (t.getAttribute("data-f")) { draft[t.getAttribute("data-f")] = t.value; return; }
      if (t.getAttribute("data-a")) {
        var a = addr();
        draft.address = { line1: a.line1 || "", line2: a.line2 || "", city: a.city || "", state: a.state || "", postcode: a.postcode || "" };
        draft.address[t.getAttribute("data-a")] = t.value;
        return;
      }
      if (!t.classList || !t.classList.contains("filter") || view.kind !== "brand") return;
      view.filter = t.value;
      var grid = body.querySelector(".models");
      if (grid) grid.innerHTML = modelButtons((view.series || view.brand.series[0]).models);
    });
    shadow.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && mode) { e.stopPropagation(); closePanel(); }
      // Enter in a quantity box applies it at once
      if (e.key === "Enter" && e.target && e.target.getAttribute && e.target.getAttribute("data-qty") != null) e.target.blur();
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
      // the 3D view puts its parts list under the model below this width
      root.classList.toggle("narrow3d", mount.clientWidth > 0 && mount.clientWidth < 820);
    };
    if (window.ResizeObserver) new ResizeObserver(sizeClass).observe(mount);
    else window.addEventListener("resize", sizeClass);
    sizeClass();

    // ── start ──
    // The parts, for a signed-in customer.
    function loadCatalog() {
      root.classList.remove("locked");
      loading();
      renderCrumbs();
      var mine = ++seq;
      api("/widget/embed-ordering/catalog")
        .then(function (j) {
          if (mine !== seq) return;
          catalog = j;
          diagrams = {};
          (j.diagrams || []).forEach(function (d) { diagrams[(d.brand + "|" + d.model).toLowerCase()] = true; });
          var next = afterSignIn;
          afterSignIn = "";
          if (next) setTimeout(function () { openPanel(next); }, 0);
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
        .catch(function (e) {
          if (e && e.status === 401) return expired();
          if (mine === seq) message("The parts list couldn’t be loaded.", true);
        });
    }

    function start() {
      root.classList.add("locked");
      loading();
      crumbsEl.innerHTML = "";
      if (!key) return message("This ordering widget has no distributor key (data-distributor-key).");
      // whose widget this is (and whether this website may use it)
      api("/widget/embed-ordering/info")
        .then(function (j) {
          distName = j.distributor || "";
          if (!token) return showGate();
          // still signed in? (the session may have expired or the account closed)
          return call("GET", "/widget/embed-ordering/me").then(function (r) {
            if (r.status === 200 && r.j.customer) {
              me = r.j.customer;
              save(store + "me", me);
              paintAccount();
              return loadCatalog();
            }
            if (r.status === 401) return signedOut();
            message("The parts list couldn’t be loaded.", true);
          });
        })
        .catch(function (e) {
          message(e && e.status === 403 ? esc(e.message) : "The ordering page couldn’t be loaded.", !(e && e.status === 403));
        });
    }
    paintBadge();
    paintAccount();
    start();
  }

  function boot() {
    var m = document.getElementById(MOUNT_ID);
    if (m) init(m);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
