/*!
 * iMobile Banner Carousel widget — v1
 *
 * Embed:
 *   <div id="imobile-banner-carousel"></div>
 *   <script src="https://<backend>/widget-assets/banner-carousel/v1.js" defer></script>
 *
 * Optional data attributes on the mount div:
 *   data-api-base="https://<backend>"  where the banners come from (default:
 *                                      the server this script was loaded from)
 *   data-interval="5000"               autoplay delay in ms; 0 = no autoplay
 *   data-radius="0"                    corner radius in px
 *   data-tablet-min="768"              container width where the tablet image starts
 *   data-desktop-min="1024"            container width where the desktop image starts
 *   data-label="Promotions"            accessible name of the carousel
 *   data-no-cache="true"               always fetch fresh (the dashboard preview)
 *   data-max-height / data-max-width   px; override the Banner page's Display
 *                                      settings for this one embed
 *
 * The banners are managed on the dashboard (iMobile Website → Banner): each
 * has a desktop, tablet and mobile image and an optional link. The image is
 * picked by the CONTAINER's width (not the window's), so the carousel also
 * suits a narrower column; its height follows the first banner's image for
 * that device. Hand-written vanilla JS, no build step, rendered in a Shadow
 * DOM so host page CSS can't leak in. Data: GET /widget/bannerCarousel/banners
 *
 * Size limits (Display on the Banner page, sent with the banners): past the
 * max height the carousel stops growing taller and the image is trimmed
 * equally top and bottom (object-fit: cover); past the max width it stops
 * growing wider and sits centred — the image is then picked for that width.
 */
(function () {
  "use strict";

  var MOUNT_ID = "imobile-banner-carousel";
  var SLIDE_MS = 550;
  var RATIO_KEY = "imobile-banner-ratio"; // last seen shape per device + limits, to hold the space
  var SCRIPT = document.currentScript;

  var CSS = [
    ":host{all:initial;display:block}",
    "*{box-sizing:border-box}",
    ".root{position:relative;width:100%;margin:0 auto;overflow:hidden;border-radius:var(--radius,0);",
    "  background:#f3f4f6;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;",
    "  -webkit-tap-highlight-color:transparent}",
    ".viewport{position:relative;width:100%;overflow:hidden;touch-action:pan-y}",
    ".track{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;will-change:transform}",
    ".track.anim{transition:transform " + SLIDE_MS + "ms cubic-bezier(.22,.61,.36,1)}",
    ".slide{position:relative;flex:0 0 100%;width:100%;height:100%;display:block;overflow:hidden;",
    "  -webkit-user-drag:none;user-select:none;-webkit-user-select:none;outline:none}",
    ".slide img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;display:block;",
    "  -webkit-user-drag:none;user-select:none;pointer-events:none}",
    "a.slide:focus-visible{box-shadow:inset 0 0 0 3px #fff,inset 0 0 0 5px #111}",
    ".nav{position:absolute;top:50%;z-index:2;width:40px;height:40px;margin-top:-20px;padding:0;border:0;",
    "  border-radius:50%;background:rgba(255,255,255,.88);color:#111827;cursor:pointer;display:flex;",
    "  align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.18);opacity:0;",
    "  transition:opacity .2s,background .2s}",
    ".nav:hover{background:#fff}",
    ".nav svg{width:18px;height:18px;display:block}",
    ".prev{left:14px}.next{right:14px}",
    ".root:hover .nav,.nav:focus-visible{opacity:1}",
    ".nav:focus-visible{outline:2px solid #111827;outline-offset:2px}",
    "@media (hover:none){.nav{opacity:.9}}",
    ".root.mobile .nav{display:none}",
    ".dots{position:absolute;left:0;right:0;bottom:12px;z-index:2;display:flex;justify-content:center;",
    "  gap:6px;pointer-events:none}",
    ".dot{pointer-events:auto;width:8px;height:8px;padding:0;border:0;border-radius:4px;cursor:pointer;",
    "  background:rgba(255,255,255,.62);box-shadow:0 0 0 1px rgba(0,0,0,.1);transition:width .25s,background .25s}",
    ".dot[aria-current='true']{width:22px;background:#fff}",
    ".dot:focus-visible{outline:2px solid #111827;outline-offset:2px}",
    ".root.mobile .dots{bottom:8px}",
    ".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
    "@media (prefers-reduced-motion:reduce){.track.anim{transition:none}}",
  ].join("\n");

  var ARROW_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  var ARROW_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';

  function num(v, dflt) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : dflt;
  }

  function scriptOrigin() {
    try {
      return SCRIPT && SCRIPT.src ? new URL(SCRIPT.src).origin : "";
    } catch (e) {
      return "";
    }
  }

  function readRatios() {
    try {
      return JSON.parse(localStorage.getItem(RATIO_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  function saveRatios(r) {
    try {
      localStorage.setItem(RATIO_KEY, JSON.stringify(r));
    } catch (e) { /* private mode — only costs the placeholder */ }
  }

  function el(tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }

  function init(mount) {
    if (mount.__imobileBanner) return;
    mount.__imobileBanner = true;

    var opt = {
      base: (mount.getAttribute("data-api-base") || scriptOrigin()).replace(/\/+$/, ""),
      interval: Math.max(0, num(mount.getAttribute("data-interval"), 5000)),
      radius: Math.max(0, num(mount.getAttribute("data-radius"), 0)),
      tabletMin: num(mount.getAttribute("data-tablet-min"), 768),
      desktopMin: num(mount.getAttribute("data-desktop-min"), 1024),
      label: mount.getAttribute("data-label") || "Promotions",
      noCache: mount.getAttribute("data-no-cache") === "true",
      maxHeight: num(mount.getAttribute("data-max-height"), 0) || null,
      maxWidth: num(mount.getAttribute("data-max-width"), 0) || null,
    };

    var shadow = mount.attachShadow ? mount.attachShadow({ mode: "open" }) : mount;
    var style = el("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ── state ──
    var banners = [];
    var n = 0;
    var device = null;
    var index = 0; // the real banner showing, 0..n-1
    var pos = 0; // track position; with the loop clones, banner i sits at i + 1
    var restLoaded = false;
    var root, viewport, track, slides = [], dots = [], live;
    var settleTimer = null, playTimer = null;
    var paused = { hover: false, focus: false, hidden: document.hidden, drag: false, offscreen: false };
    var ratio = 0; // height / width of the showing device's image
    // Size limits: the embed's own attributes win, else the Banner page's
    // settings (last seen ones until the banners arrive).
    var saved0 = readRatios();
    var lim = { maxHeight: opt.maxHeight || saved0.mh || null, maxWidth: opt.maxWidth || saved0.mw || null };

    // The carousel's width (the mount's, capped by the max width); 0 while
    // the mount isn't laid out or sits in a hidden tab — the ResizeObserver
    // brings the real width.
    function widthNow() {
      var w = mount.getBoundingClientRect().width || 0;
      return lim.maxWidth ? Math.min(w, lim.maxWidth) : w;
    }
    // Height follows the image's shape up to the max height.
    function heightFor(w, r) {
      var h = w * r;
      return Math.round(lim.maxHeight ? Math.min(h, lim.maxHeight) : h);
    }
    function applyWidth() {
      if (root) root.style.maxWidth = lim.maxWidth ? lim.maxWidth + "px" : "";
    }
    function size() {
      var w = widthNow();
      if (w && ratio && viewport) viewport.style.height = heightFor(w, ratio) + "px";
    }
    function deviceFor(w) {
      return w >= opt.desktopMin ? "desktop" : w >= opt.tabletMin ? "tablet" : "mobile";
    }

    // Hold the space on a return visit (the shape seen last time) so the
    // page doesn't jump when the banners arrive.
    function placeholder() {
      var w = widthNow();
      if (!w) return;
      var r = readRatios()[deviceFor(w)];
      if (!(r > 0 && r < 5)) return;
      root = el("div", "root");
      root.style.setProperty("--radius", opt.radius + "px");
      applyWidth();
      viewport = el("div", "viewport");
      viewport.style.height = heightFor(w, r) + "px";
      root.appendChild(viewport);
      shadow.appendChild(root);
    }

    function clear() {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    function load() {
      var url = opt.base + "/widget/bannerCarousel/banners";
      return fetch(url, { credentials: "omit", cache: opt.noCache ? "no-store" : "default" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (d) {
          banners = (d && d.banners) || [];
          n = banners.length;
          var st = (d && d.settings) || {};
          lim.maxHeight = opt.maxHeight || st.maxHeight || null;
          lim.maxWidth = opt.maxWidth || st.maxWidth || null;
          if (!n) {
            clear();
            saveRatios({});
            return;
          }
          build();
        })
        .catch(function (e) {
          clear();
          if (window.console) console.warn("[iMobile banner carousel] could not load the banners:", e && e.message);
        });
    }

    // ── build ──
    function slideFor(b, clone) {
      var s;
      if (b.link) {
        s = el("a", "slide", { href: b.link, draggable: "false" });
        if (b.newTab) {
          s.target = "_blank";
          s.rel = "noopener";
        }
      } else {
        s = el("div", "slide");
      }
      var img = el("img", "", { alt: clone ? "" : b.title || "", draggable: "false", decoding: "async" });
      s.appendChild(img);
      if (clone) {
        s.setAttribute("aria-hidden", "true");
        if (b.link) s.tabIndex = -1;
      } else {
        s.setAttribute("role", "group");
        s.setAttribute("aria-roledescription", "slide");
      }
      s.__banner = b;
      s.__img = img;
      return s;
    }

    function build() {
      clear();
      root = el("div", "root", { role: "region", "aria-roledescription": "carousel", "aria-label": opt.label });
      root.style.setProperty("--radius", opt.radius + "px");
      applyWidth();
      viewport = el("div", "viewport");
      track = el("div", "track");
      live = el("div", "sr", { "aria-live": "polite", "aria-atomic": "true" });

      slides = [];
      if (n > 1) slides.push(slideFor(banners[n - 1], true));
      banners.forEach(function (b, i) {
        var s = slideFor(b, false);
        s.setAttribute("aria-label", i + 1 + " of " + n + (b.title ? ": " + b.title : ""));
        slides.push(s);
      });
      if (n > 1) slides.push(slideFor(banners[0], true));
      slides.forEach(function (s) {
        track.appendChild(s);
      });
      viewport.appendChild(track);
      root.appendChild(viewport);
      root.appendChild(live);

      if (n > 1) {
        var prev = el("button", "nav prev", { type: "button", "aria-label": "Previous banner" });
        prev.innerHTML = ARROW_L;
        var next = el("button", "nav next", { type: "button", "aria-label": "Next banner" });
        next.innerHTML = ARROW_R;
        prev.addEventListener("click", function () {
          go(index - 1, true);
        });
        next.addEventListener("click", function () {
          go(index + 1, true);
        });
        root.appendChild(prev);
        root.appendChild(next);

        var dotsBox = el("div", "dots");
        dots = banners.map(function (b, i) {
          var d = el("button", "dot", { type: "button", "aria-label": "Show banner " + (i + 1) });
          d.addEventListener("click", function () {
            go(i, true);
          });
          dotsBox.appendChild(d);
          return d;
        });
        root.appendChild(dotsBox);
        wire();
      }

      shadow.appendChild(root);
      index = 0;
      pos = n > 1 ? 1 : 0;
      place(false);
      applyDevice(true);
      mark();
      schedule();
    }

    // ── device / images ──
    function applyDevice(force) {
      var w = widthNow();
      if (!w) return; // not laid out yet — picked once it has a width
      var d = deviceFor(w);
      if (d === device && !force) return;
      device = d;
      root.classList.toggle("mobile", d === "mobile");

      var first = banners[0].images[d] || {};
      ratio = first.width && first.height ? first.height / first.width : { desktop: 0.3125, tablet: 0.5, mobile: 1 }[d];
      size();
      var saved = readRatios();
      saved[d] = ratio;
      saved.mh = lim.maxHeight;
      saved.mw = lim.maxWidth;
      saveRatios(saved);

      // The banner showing loads first; the rest follow once it is in.
      var cur = slides[pos];
      setSrc(cur, true);
      if (restLoaded) {
        slides.forEach(function (s) {
          setSrc(s, false);
        });
      } else {
        var go2 = function () {
          if (restLoaded) return;
          restLoaded = true;
          slides.forEach(function (s) {
            setSrc(s, false);
          });
        };
        if (cur.__img.complete && cur.__img.naturalWidth) go2();
        else {
          cur.__img.addEventListener("load", go2, { once: true });
          cur.__img.addEventListener("error", go2, { once: true });
          setTimeout(go2, 2500);
        }
      }
    }

    function setSrc(s, first) {
      var img = s.__banner.images[device] || {};
      if (!img.url || s.__img.getAttribute("src") === img.url) return;
      if (first) s.__img.setAttribute("fetchpriority", "high");
      s.__img.src = img.url;
    }

    // ── movement ──
    function place(animate, dragPx) {
      track.classList.toggle("anim", !!animate && !reduced);
      track.style.transform =
        "translate3d(" + (dragPx ? "calc(" + -pos * 100 + "% + " + dragPx + "px)" : -pos * 100 + "%") + ",0,0)";
    }

    function go(i, user) {
      if (n < 2) return;
      settle(); // finish any slide still running
      pos = i + 1; // may land on a clone (0 or n + 1)
      index = ((i % n) + n) % n;
      place(true);
      mark();
      if (user) live.textContent = "Banner " + (index + 1) + " of " + n;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, (reduced ? 0 : SLIDE_MS) + 60);
      schedule();
    }

    // Off a clone, jump (unanimated) to the real banner it copies.
    function settle() {
      clearTimeout(settleTimer);
      settleTimer = null;
      if (n < 2) return;
      if (pos === 0 || pos === n + 1) {
        pos = index + 1;
        place(false);
        void track.offsetWidth; // commit the jump before any next animation
      }
    }

    // Current dot + which slide is reachable by keyboard / screen reader.
    function mark() {
      dots.forEach(function (d, i) {
        d.setAttribute("aria-current", i === index ? "true" : "false");
      });
      var off = n > 1 ? 1 : 0;
      banners.forEach(function (b, i) {
        var s = slides[i + off];
        var on = i === index;
        s.setAttribute("aria-hidden", on ? "false" : "true");
        if (s.tagName === "A") s.tabIndex = on ? 0 : -1;
      });
    }

    // ── autoplay ──
    function schedule() {
      clearTimeout(playTimer);
      playTimer = null;
      var stopped = n < 2 || !opt.interval || reduced;
      for (var k in paused) if (paused[k]) stopped = true;
      if (live) live.setAttribute("aria-live", stopped ? "polite" : "off");
      if (!stopped) {
        playTimer = setTimeout(function () {
          go(index + 1, false);
        }, opt.interval);
      }
    }

    // ── input ──
    function wire() {
      // A mouse resting on the banner holds it. Pointer events rather than
      // mouseenter: a tap on a phone fires a mouseenter that never leaves.
      root.addEventListener("pointerenter", function (e) {
        if (e.pointerType !== "mouse") return;
        paused.hover = true;
        schedule();
      });
      root.addEventListener("pointerleave", function (e) {
        if (e.pointerType !== "mouse") return;
        paused.hover = false;
        schedule();
      });
      // Keyboard focus holds the banner; a mouse click or drag also focuses
      // the button / link but must not stop the autoplay for good.
      root.addEventListener("focusin", function (e) {
        var keyboard = true;
        try {
          keyboard = e.target.matches(":focus-visible");
        } catch (err) { /* older browser: treat as keyboard */ }
        paused.focus = keyboard;
        schedule();
      });
      root.addEventListener("focusout", function (e) {
        if (!root.contains(e.relatedTarget)) {
          paused.focus = false;
          schedule();
        }
      });
      root.addEventListener("keydown", function (e) {
        if (e.key === "ArrowLeft") {
          go(index - 1, true);
          e.preventDefault();
        } else if (e.key === "ArrowRight") {
          go(index + 1, true);
          e.preventDefault();
        }
      });
      track.addEventListener("transitionend", function (e) {
        if (e.target === track) settle();
      });

      // Swipe / drag. Vertical moves stay with the page (touch-action:
      // pan-y); a drag never also counts as a click on the banner link.
      var start = null, dragging = false, dx = 0, suppressClick = false;
      viewport.addEventListener("pointerdown", function (e) {
        if (e.button !== 0) return;
        settle();
        start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, w: viewport.clientWidth || 1 };
        dragging = false;
        dx = 0;
      });
      viewport.addEventListener("pointermove", function (e) {
        if (!start || e.pointerId !== start.id) return;
        dx = e.clientX - start.x;
        var dy = e.clientY - start.y;
        if (!dragging) {
          if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) return;
          dragging = true;
          paused.drag = true;
          schedule();
          try {
            viewport.setPointerCapture(e.pointerId);
          } catch (err) { /* capture is only a nicety */ }
        }
        place(false, dx);
      });
      function end(e, cancelled) {
        if (!start || (e && e.pointerId !== start.id)) return;
        var s = start;
        start = null;
        if (!dragging) return;
        dragging = false;
        paused.drag = false;
        suppressClick = true;
        setTimeout(function () {
          suppressClick = false;
        }, 400);
        var fast = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, Date.now() - s.t) > 0.4;
        if (!cancelled && (Math.abs(dx) > s.w * 0.15 || fast)) go(dx < 0 ? index + 1 : index - 1, true);
        else go(index, false); // back into place
      }
      viewport.addEventListener("pointerup", function (e) {
        end(e, false);
      });
      viewport.addEventListener("pointercancel", function (e) {
        end(e, true);
      });
      viewport.addEventListener(
        "click",
        function (e) {
          if (suppressClick) {
            e.preventDefault();
            e.stopPropagation();
            suppressClick = false;
          }
        },
        true,
      );
    }

    document.addEventListener("visibilitychange", function () {
      paused.hidden = document.hidden;
      schedule();
    });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        paused.offscreen = !entries[0].isIntersecting;
        schedule();
      }).observe(mount);
    }
    var onResize = function () {
      if (!root || !banners.length) return;
      applyDevice(false);
      size(); // the height follows every width change, not only device switches
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe(mount);
    else window.addEventListener("resize", onResize);

    placeholder();
    load();
  }

  function boot() {
    var m = document.getElementById(MOUNT_ID);
    if (m) init(m);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
