/*!
 * iMobile Notification widget — v1
 *
 * Embed once, wherever it should pop up (the site-wide code for every page):
 *   <script src="https://<backend>/widget-assets/notification/v1.js" defer></script>
 *
 * Optional data attributes on the script tag:
 *   data-api-base="https://<backend>"  where the notifications come from
 *                                      (default: the server this script was loaded from)
 *   data-accent="#0b7fd4"              colour of the button and the bell
 *   data-delay="600"                   ms after the page is ready before it pops up
 *   data-no-cache="true"               always fetch fresh and forget what this
 *                                      browser has seen (the demo page)
 *
 * The notifications are managed on the dashboard (iMobile Website →
 * Notification): the server sends only the ones inside their time period, so
 * there is nothing to show outside it. Each says how often one shopper sees
 * it — once per visit (sessionStorage), once ever (localStorage) or every time
 * a page opens — and is counted as seen when it shows. Several at once pop up
 * one after the other.
 *
 * Nothing here ever shows the shopper an error: no notification, a refused
 * website or a failed request all mean no popup. Text goes in as text, never
 * as HTML. Hand-written vanilla JS, no build step, rendered in a Shadow DOM so
 * host page CSS can't leak in. Data: GET /widget/notification/active
 *
 * The dashboard's Preview sets window.__imobileNotificationPreview to one
 * notification first: that one shows at once, with no request and no memory.
 */
(function () {
  "use strict";

  if (window.__imobileNotificationLoaded) return;
  window.__imobileNotificationLoaded = true;

  var HOST_ID = "imobile-notification";
  var SEEN_PREFIX = "imobile-notification:";
  var FADE_MS = 200;
  var SCRIPT = document.currentScript;

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    ".overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:flex;align-items:center;",
    "  justify-content:center;padding:16px;overflow:auto;overscroll-behavior:contain;background:rgba(15,23,42,.5);",
    "  font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;opacity:0;transition:opacity " + FADE_MS + "ms}",
    ".overlay.in{opacity:1}",
    ".card{position:relative;width:100%;max-width:420px;margin:auto;padding:26px 26px 22px;border-radius:16px;background:#fff;",
    "  color:#10213f;box-shadow:0 24px 60px rgba(15,23,42,.3);outline:none;transform:translateY(12px) scale(.98);",
    "  transition:transform " + FADE_MS + "ms cubic-bezier(.22,.61,.36,1)}",
    ".overlay.in .card{transform:none}",
    ".x{position:absolute;top:12px;right:12px;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:none;",
    "  color:#66758c;cursor:pointer;display:flex;align-items:center;justify-content:center}",
    ".x:hover{background:#f1f4f9;color:#10213f}",
    ".x svg{width:18px;height:18px;display:block}",
    ".bell{position:relative;display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:14px;",
    "  border-radius:12px;color:var(--accent);overflow:hidden}",
    ".bell::before{content:'';position:absolute;top:0;right:0;bottom:0;left:0;background:var(--accent);opacity:.12}",
    ".bell svg{position:relative;width:22px;height:22px;display:block}",
    ".title{margin:0;padding-right:20px;font-size:19px;font-weight:700;line-height:1.3;overflow-wrap:anywhere}",
    ".msg{margin:8px 0 0;font-size:14px;line-height:1.6;color:#3b4a63;white-space:pre-line;overflow-wrap:anywhere}",
    ".actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}",
    ".btn{flex:1 1 auto;min-height:42px;padding:10px 16px;border:1px solid #d7deea;border-radius:10px;background:#fff;",
    "  color:#10213f;font:inherit;font-size:14px;font-weight:600;line-height:20px;text-align:center;text-decoration:none;cursor:pointer}",
    ".btn:hover{background:#f5f7fb}",
    ".btn.main{border-color:var(--accent);background:var(--accent);color:#fff}",
    ".btn.main:hover{filter:brightness(.94)}",
    ".x:focus-visible,.btn:focus-visible{outline:2px solid #10213f;outline-offset:2px}",
    "@media (prefers-reduced-motion:reduce){.overlay,.card{transition:none}.card{transform:none}}",
  ].join("\n");

  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  function attr(name) {
    return (SCRIPT && SCRIPT.getAttribute(name)) || "";
  }
  function scriptOrigin() {
    try {
      return SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : "";
    } catch (e) {
      return "";
    }
  }

  var delay = parseInt(attr("data-delay"), 10);
  var opt = {
    base: (attr("data-api-base") || scriptOrigin()).replace(/\/+$/, ""),
    accent: attr("data-accent") || "#0b7fd4",
    delay: delay >= 0 ? delay : 600,
    noCache: attr("data-no-cache") === "true",
  };

  // ── what this browser has seen ──
  function seenStore(n) {
    if (n.frequency === "once") return window.localStorage;
    if (n.frequency === "always") return null;
    return window.sessionStorage;
  }
  function seenKey(n) {
    return SEEN_PREFIX + n.id + ":" + n.version;
  }
  function wasSeen(n) {
    if (opt.noCache) return false;
    try {
      var s = seenStore(n);
      return !!s && s.getItem(seenKey(n)) === "1";
    } catch (e) {
      return false; // private mode — it only shows again
    }
  }
  function markSeen(n) {
    if (opt.noCache) return;
    try {
      var s = seenStore(n);
      if (s) s.setItem(seenKey(n), "1");
    } catch (e) { /* private mode — it only shows again */ }
  }

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  // the server checked it; the same rule again, as this lands in an href
  function safeLink(link) {
    return /^(https?:\/\/|\/(?!\/))/i.test(link || "") ? link : "";
  }

  // ── the popup ──
  var queue = [];
  var shadow = null;

  function mountShadow() {
    if (shadow) return shadow;
    var host = el("div", "", { id: HOST_ID });
    document.body.appendChild(host);
    shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = el("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    return shadow;
  }

  function showNext() {
    var n = queue.shift();
    while (n && wasSeen(n)) n = queue.shift();
    if (n) show(n);
  }

  function show(n) {
    var root = mountShadow();
    var previousFocus = document.activeElement;
    markSeen(n);

    var overlay = el("div", "overlay");
    overlay.style.setProperty("--accent", opt.accent);
    var card = el("div", "card", { role: "dialog", "aria-modal": "true", "aria-labelledby": "t", tabindex: "-1" });

    var close = el("button", "x", { type: "button", "aria-label": "Close" });
    close.innerHTML = ICON_X;
    var bell = el("span", "bell");
    bell.innerHTML = ICON_BELL;
    var title = el("h2", "title", { id: "t" });
    title.textContent = n.title;
    card.appendChild(close);
    card.appendChild(bell);
    card.appendChild(title);
    if (n.message) {
      var msg = el("p", "msg", { id: "m" });
      msg.textContent = n.message;
      card.setAttribute("aria-describedby", "m");
      card.appendChild(msg);
    }

    var actions = el("div", "actions");
    var link = safeLink(n.link);
    if (link) {
      var go = el("a", "btn main", { href: link });
      if (n.newTab) {
        go.setAttribute("target", "_blank");
        go.setAttribute("rel", "noopener");
      }
      go.textContent = n.buttonText || "Learn more";
      go.addEventListener("click", function () { dismiss(); });
      actions.appendChild(go);
    }
    var ok = el("button", link ? "btn" : "btn main", { type: "button" });
    ok.textContent = link ? "Close" : n.buttonText || "Got it";
    ok.addEventListener("click", dismiss);
    actions.appendChild(ok);
    card.appendChild(actions);
    overlay.appendChild(card);
    root.appendChild(overlay);

    var closed = false;
    function dismiss() {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.className = "overlay";
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (previousFocus && previousFocus.focus) {
          try { previousFocus.focus(); } catch (e) { /* it may be gone */ }
        }
        showNext();
      }, FADE_MS);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      } else if (e.key === "Tab") {
        // the page behind is out of reach while it shows
        var items = card.querySelectorAll("a,button");
        var first = items[0];
        var last = items[items.length - 1];
        var at = root.activeElement;
        if (e.shiftKey && (at === first || at === card || !at)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (at === last || !at)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    close.addEventListener("click", dismiss);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) dismiss();
    });
    document.addEventListener("keydown", onKey, true);

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { overlay.className = "overlay in"; });
    });
    try { card.focus({ preventScroll: true }); } catch (e) { card.focus(); }
  }

  // ── start ──
  function load() {
    if (!window.fetch) return;
    var preview = window.__imobileNotificationPreview;
    if (preview) {
      opt.noCache = true; // a preview remembers nothing
      queue = [preview];
      showNext();
      return;
    }
    fetch(opt.base + "/widget/notification/active", { cache: opt.noCache ? "no-store" : "default" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.notifications) return;
        queue = data.notifications.filter(function (n) { return !wasSeen(n); });
        if (queue.length) setTimeout(showNext, opt.delay);
      })
      .catch(function () { /* no popup */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
