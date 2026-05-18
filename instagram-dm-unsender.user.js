// ==UserScript==
// @name             instagram-dm-unsender
// @version          1.1
// @description      Script to unsend all DMs in a chat on instagram.com
// @author           Maxhem2
// @license          MIT
// @namespace        https://github.com/Maxhem2/Instagram-DM-Unsender
// @homepageURL      https://github.com/Maxhem2/Instagram-DM-Unsender
// @supportURL       https://github.com/Maxhem2/Instagram-DM-Unsender/issues
// @downloadURL      https://raw.githubusercontent.com/Maxhem2/Instagram-DM-Unsender/main/instagram-dm-unsender.user.js
// @updateURL        https://raw.githubusercontent.com/Maxhem2/Instagram-DM-Unsender/main/instagram-dm-unsender.user.js
// @copyright        2026, Maxhem2 (https://github.com/Maxhem2)
// @icon             https://www.instagram.com/favicon.ico
// @match            https://*.instagram.com/*
// @run-at           document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STYLE_ID = "ig-dm-unsender-style";
  const CONTROL_ID = "ig-dm-unsender-control";
  const BLOCKER_ID = "ig-dm-unsender-blocker";
  const ROUTE_POLL_MS = 1000;
  const LOG_PREFIX = "[IG DM Unsender]";
  const LOG_AUTOMATION = true;

  const GROUP_ROW_SELECTOR = 'div[role="group"][tabindex="-1"], div[role="group"]';

  const SCROLL_IDLE_TIMEOUT_MS = 1400;
  const SCROLL_IDLE_STABLE_MS = 140;
  const SCROLL_CHUNK_RATIO = 0.82;
  const SCROLL_CHUNK_MIN_PX = 220;
  const MINE_PAUSE_MS = 500;
  const ACTIVE_PULSE_MS = 150;

  const HOVER_BEFORE_MORE_CLICK_MS = 1000;
  const MORE_BUTTON_DISCOVERY_TIMEOUT_MS = 1600;
  const MENU_OPEN_VERIFY_TIMEOUT_MS = 900;

  const UNSEND_AFTER_MENU_OPEN_WAIT_MS = 1000;
  const UNSEND_BUTTON_DISCOVERY_TIMEOUT_MS = 1800;

  const CONFIRM_AFTER_UNSEND_MENU_CLICK_WAIT_MS = 1000;
  const CONFIRM_BUTTON_DISCOVERY_TIMEOUT_MS = 2200;
  const AFTER_CONFIRM_CLICK_PAUSE_MS = 1200;

  const AFTER_MORE_CLICK_PAUSE_MS = 900;

  const CHAT_START_AVATAR_MIN_PX = 72;
  const CHAT_START_AVATAR_MAX_PX = 128;
  const CHAT_START_AVATAR_EXPECTED_PX = 96;
  const CHAT_START_MAX_ANCESTOR_STEPS = 14;

  let lastUrl = location.href;
  let rafId = 0;
  let mutationObserver = null;
  let autoScrollRunId = 0;
  let autoScrolling = false;
  let interactionBlocked = false;
  let trustedInputBlockerInstalled = false;

  let currentTargetRow = null;
  let currentTargetRowId = "";
  let currentTargetType = null;
  let currentTargetSignature = "";
  let currentTargetViewportTop = NaN;
  let currentTargetViewportCenter = NaN;

  let pendingResumeTarget = null;
  let lastPausedMineKey = "";

  let activePulseTimer = 0;
  let activeRow = null;
  let revealedNodes = [];
  let modifiedRows = [];

  let nextSyntheticRowId = 1;

  function logInfo(...args) {
    if (LOG_AUTOMATION) console.info(LOG_PREFIX, new Date().toLocaleTimeString(), ...args);
  }

  function logWarn(...args) {
    if (LOG_AUTOMATION) console.warn(LOG_PREFIX, new Date().toLocaleTimeString(), ...args);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitWhileActive(ms, runId) {
    const started = performance.now();

    while (performance.now() - started < ms) {
      if (!autoScrolling || runId !== autoScrollRunId) return false;
      await wait(50);
    }

    return autoScrolling && runId === autoScrollRunId;
  }

  function isDmThreadPage() {
    return /^\/direct\/t\//.test(location.pathname);
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function rectOf(el) {
    return el.getBoundingClientRect();
  }

  function textOf(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!isElement(el) || !el.isConnected) return false;

    const r = rectOf(el);
    const cs = getComputedStyle(el);

    return (
      r.width > 0 &&
      r.height > 0 &&
      cs.display !== "none" &&
      cs.visibility !== "hidden" &&
      cs.opacity !== "0"
    );
  }

  function rectSummary(el) {
    if (!isElement(el) || !el.isConnected) return "rect=detached";

    const r = rectOf(el);
    return `rect={x:${Math.round(r.left)},y:${Math.round(r.top)},w:${Math.round(r.width)},h:${Math.round(r.height)}}`;
  }

  function describeElement(el) {
    if (!el) return "(null)";
    if (!isElement(el)) return String(el);

    const bits = [(el.tagName || "").toLowerCase()];

    for (const attr of ["role", "aria-haspopup", "aria-expanded", "tabindex"]) {
      const value = el.getAttribute(attr);
      if (value) bits.push(`${attr}=${JSON.stringify(value)}`);
    }

    bits.push(rectSummary(el));

    return bits.join(" ");
  }

  function describeRow(row) {
    if (!row) return "(no row)";

    return `row id=${getRowId(row) || "(none)"} type=${getRowType(row) || "(unknown)"} ${rectSummary(row)} text=${JSON.stringify(textOf(row).slice(0, 120))}`;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${CONTROL_ID} {
        position: relative !important;
        z-index: 2147483647 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 116px !important;
        height: 32px !important;
        margin-left: 8px !important;
        padding: 0 12px !important;
        border: 1px solid rgba(255, 255, 255, 0.22) !important;
        border-radius: 999px !important;
        background: rgba(17, 24, 39, 0.88) !important;
        color: white !important;
        font: 700 12px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        letter-spacing: 0.01em !important;
        white-space: nowrap !important;
        cursor: pointer !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }

      #${CONTROL_ID}:hover {
        background: rgba(31, 41, 55, 0.96) !important;
      }

      #${CONTROL_ID}.active {
        background: rgba(185, 28, 28, 0.94) !important;
        border-color: rgba(255, 255, 255, 0.28) !important;
      }

      #${CONTROL_ID}.fallback {
        position: fixed !important;
        right: 16px !important;
        bottom: 16px !important;
        height: 38px !important;
        margin-left: 0 !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25) !important;
      }

      #${CONTROL_ID}.floating-active {
        position: fixed !important;
        left: var(--ig-dm-unsender-control-left, auto) !important;
        top: var(--ig-dm-unsender-control-top, auto) !important;
        width: var(--ig-dm-unsender-control-width, 116px) !important;
        height: var(--ig-dm-unsender-control-height, 32px) !important;
        margin-left: 0 !important;
        z-index: 2147483647 !important;
      }

      #${BLOCKER_ID} {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483646 !important;
        display: none !important;
        align-items: center !important;
        justify-content: center !important;
        pointer-events: auto !important;
        cursor: not-allowed !important;
        background: rgba(0, 0, 0, 0.001) !important;
      }

      body[data-ig-dm-unsender-blocked="1"] #${BLOCKER_ID} {
        display: flex !important;
      }

      #${BLOCKER_ID} .ig-dm-unsender-blocker-card {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 170px !important;
        padding: 13px 16px !important;
        border-radius: 999px !important;
        color: white !important;
        background: rgba(17, 24, 39, 0.82) !important;
        border: 1px solid rgba(255, 255, 255, 0.18) !important;
        font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.35) !important;
        pointer-events: none !important;
      }

      body[data-ig-dm-unsender-blocked="1"],
      body[data-ig-dm-unsender-blocked="1"] *:not(#${CONTROL_ID}):not(#${CONTROL_ID} *) {
        user-select: none !important;
        -webkit-user-select: none !important;
      }

      [data-ig-dm-active-row="1"],
      [data-ig-dm-hover-row="1"] {
        outline: none !important;
      }

      [data-ig-dm-active-row="1"],
      [data-ig-dm-active-row="1"] *,
      [data-ig-dm-hover-row="1"],
      [data-ig-dm-hover-row="1"] * {
        transition: none !important;
        animation-duration: 0s !important;
      }

      [data-ig-dm-active-row="1"] [role="button"],
      [data-ig-dm-active-row="1"] button,
      [data-ig-dm-active-row="1"] a,
      [data-ig-dm-active-row="1"] [aria-label],
      [data-ig-dm-active-row="1"] [tabindex],
      [data-ig-dm-hover-row="1"] [role="button"],
      [data-ig-dm-hover-row="1"] button,
      [data-ig-dm-hover-row="1"] a,
      [data-ig-dm-hover-row="1"] [aria-label],
      [data-ig-dm-hover-row="1"] [tabindex] {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }
    `;

    document.head.appendChild(style);
  }

  function ensureBlocker() {
    let blocker = document.getElementById(BLOCKER_ID);

    if (!blocker) {
      blocker = document.createElement("div");
      blocker.id = BLOCKER_ID;
      blocker.setAttribute("aria-hidden", "true");
      blocker.innerHTML = `<div class="ig-dm-unsender-blocker-card"><span>Unsender running</span></div>`;

      blocker.addEventListener("click", (event) => {
        if (!autoScrolling) return;
        if (!event.isTrusted) return;

        if (eventPointHitsControl(event)) {
          event.preventDefault();
          event.stopPropagation();
          stopAutoScroll({ clearIndicator: true });
        }
      });

      blocker.addEventListener("pointerup", (event) => {
        if (!autoScrolling) return;
        if (!event.isTrusted) return;

        if (eventPointHitsControl(event)) {
          event.preventDefault();
          event.stopPropagation();
          stopAutoScroll({ clearIndicator: true });
        }
      });

      document.body.appendChild(blocker);
    }

    return blocker;
  }

  function getControlRect() {
    const button = document.getElementById(CONTROL_ID);
    if (!button || !button.isConnected) return null;

    const r = button.getBoundingClientRect();
    if (!r.width || !r.height) return null;

    return r;
  }

  function eventPointHitsControl(event) {
    const r = getControlRect();
    if (!r) return false;

    const x = event.clientX;
    const y = event.clientY;

    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

    return (
      x >= r.left - 8 &&
      x <= r.right + 8 &&
      y >= r.top - 8 &&
      y <= r.bottom + 8
    );
  }

  function isControlEventTarget(target) {
    const el = target instanceof Element ? target : target?.parentElement;
    return !!el && !!el.closest?.(`#${CONTROL_ID}`);
  }

  function trustedInputBlocker(event) {
    if (!interactionBlocked) return;
    if (!event.isTrusted) return;

    if (isControlEventTarget(event.target)) return;

    if (eventPointHitsControl(event)) {
      if (
        event.type === "click" ||
        event.type === "pointerup" ||
        event.type === "mouseup" ||
        event.type === "touchend"
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stopAutoScroll({ clearIndicator: true });
        return;
      }
    }

    if (event.type === "keydown" && event.key === "Escape") return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function installTrustedInputBlocker() {
    if (trustedInputBlockerInstalled) return;

    trustedInputBlockerInstalled = true;

    const blockedEvents = [
      "auxclick",
      "beforeinput",
      "click",
      "contextmenu",
      "dblclick",
      "drag",
      "dragend",
      "dragenter",
      "dragleave",
      "dragover",
      "dragstart",
      "drop",
      "input",
      "keydown",
      "keypress",
      "keyup",
      "mousedown",
      "mouseenter",
      "mouseleave",
      "mousemove",
      "mouseout",
      "mouseover",
      "mouseup",
      "pointercancel",
      "pointerdown",
      "pointerenter",
      "pointerleave",
      "pointermove",
      "pointerout",
      "pointerover",
      "pointerup",
      "selectionchange",
      "touchcancel",
      "touchend",
      "touchmove",
      "touchstart",
      "wheel"
    ];

    for (const eventName of blockedEvents) {
      window.addEventListener(eventName, trustedInputBlocker, {
        capture: true,
        passive: false,
      });

      document.addEventListener(eventName, trustedInputBlocker, {
        capture: true,
        passive: false,
      });
    }
  }

  function setInteractionBlocked(blocked) {
    interactionBlocked = !!blocked;
    installTrustedInputBlocker();
    ensureBlocker();

    if (interactionBlocked) {
      document.body?.setAttribute("data-ig-dm-unsender-blocked", "1");
    } else {
      document.body?.removeAttribute("data-ig-dm-unsender-blocked");
    }
  }

  function removeLegacyVisualLayer() {
    for (const id of ["ig-dm-marker-layer", "ig-dm-unsender-layer"]) {
      const layer = document.getElementById(id);
      if (layer) layer.remove();
    }

    document.querySelectorAll([
      "[data-ig-dm-more-candidate]",
      "[data-ig-dm-more-clicking]",
      "[data-ig-dm-unsend-candidate]",
      "[data-ig-dm-unsend-clicking]",
      "[data-ig-dm-confirm-candidate]",
      "[data-ig-dm-confirm-clicking]"
    ].join(",")).forEach((el) => {
      el.removeAttribute("data-ig-dm-more-candidate");
      el.removeAttribute("data-ig-dm-more-clicking");
      el.removeAttribute("data-ig-dm-unsend-candidate");
      el.removeAttribute("data-ig-dm-unsend-clicking");
      el.removeAttribute("data-ig-dm-confirm-candidate");
      el.removeAttribute("data-ig-dm-confirm-clicking");
    });
  }

  function isSingleSegmentInstagramPath(href) {
    if (!href) return false;

    try {
      const url = new URL(href, location.origin);
      if (url.origin !== location.origin) return false;

      const path = url.pathname.replace(/\/+$/, "");
      if (!path || path === "/" || !/^\/[^/]+$/.test(path)) return false;

      const segment = path.slice(1).toLowerCase();

      return ![
        "about",
        "accounts",
        "api",
        "challenge",
        "developer",
        "direct",
        "explore",
        "graphql",
        "legal",
        "oauth",
        "p",
        "reel",
        "reels",
        "stories",
        "web"
      ].includes(segment);
    } catch {
      return false;
    }
  }

  function isHeaderProfileLink(link) {
    if (!isElement(link) || !link.isConnected) return false;
    if ((link.tagName || "").toLowerCase() !== "a") return false;
    if (!isSingleSegmentInstagramPath(link.getAttribute("href"))) return false;
    if (!link.querySelector("img, h1, h2")) return false;

    const r = rectOf(link);

    return r.height >= 28 && r.height <= 104 && r.top >= -20 && r.top <= 190;
  }

  function isHeaderActionButton(button) {
    if (!isElement(button) || !button.isConnected) return false;
    if (button.id === CONTROL_ID) return false;

    const role = (button.getAttribute("role") || "").toLowerCase();
    const tag = (button.tagName || "").toLowerCase();

    if (role !== "button" && tag !== "button") return false;
    if (!button.querySelector('svg[viewBox="0 0 24 24"]')) return false;

    const r = rectOf(button);

    return r.width >= 24 && r.width <= 80 && r.height >= 24 && r.height <= 80;
  }

  function scoreHeaderActionContainer(container) {
    if (!isElement(container) || !container.isConnected) return -Infinity;
    if (container.querySelector("a[href]")) return -Infinity;

    const buttons = Array.from(container.querySelectorAll('[role="button"], button')).filter(isHeaderActionButton);

    if (!buttons.length) return -Infinity;

    const r = rectOf(container);

    let score = 0;

    score += Math.min(buttons.length, 4) * 220;

    if (r.top >= -20 && r.top <= 150) score += 500;
    if (r.height >= 28 && r.height <= 90) score += 160;
    if (r.right > window.innerWidth * 0.45) score += 100;

    return score;
  }

  function findHeaderActionContainer() {
    const root = document.querySelector("main") || document.body;
    const candidates = new Set();
    const profileLinks = Array.from(root.querySelectorAll("a[href]")).filter(isHeaderProfileLink);

    for (const link of profileLinks) {
      let cur = link.parentElement;

      for (let depth = 0; depth < 9 && cur && cur !== document.body; depth++, cur = cur.parentElement) {
        for (const child of Array.from(cur.children)) {
          if (child === link || link.contains(child) || child.contains(link)) continue;
          if (scoreHeaderActionContainer(child) > -Infinity) candidates.add(child);
        }
      }
    }

    if (!candidates.size) {
      root.querySelectorAll("div, span").forEach((el) => {
        if (scoreHeaderActionContainer(el) > -Infinity) candidates.add(el);
      });
    }

    let best = null;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const score = scoreHeaderActionContainer(candidate);

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best;
  }

  function setFloatingActiveControlPosition(button) {
    const r = button.getBoundingClientRect();

    if (!r.width || !r.height) return;

    button.style.setProperty("--ig-dm-unsender-control-left", `${Math.round(r.left)}px`);
    button.style.setProperty("--ig-dm-unsender-control-top", `${Math.round(r.top)}px`);
    button.style.setProperty("--ig-dm-unsender-control-width", `${Math.round(r.width)}px`);
    button.style.setProperty("--ig-dm-unsender-control-height", `${Math.round(r.height)}px`);
  }

  function placeControlInHeader(button) {
    const headerActions = findHeaderActionContainer();

    if (headerActions && headerActions.isConnected) {
      button.classList.remove("fallback");

      if (button.parentElement !== headerActions) {
        headerActions.appendChild(button);
      }

      return true;
    }

    button.classList.add("fallback");

    if (button.parentElement !== document.body) {
      document.body.appendChild(button);
    }

    return false;
  }

  function ensureControl() {
    injectStyle();

    let button = document.getElementById(CONTROL_ID);

    if (!button) {
      button = document.createElement("button");
      button.id = CONTROL_ID;
      button.type = "button";

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        startScrollToPreviousMine();
      });
    }

    button.textContent = autoScrolling ? "Stop unsender" : "Start unsender";
    button.classList.toggle("active", autoScrolling);
    button.style.display = isDmThreadPage() ? "inline-flex" : "none";

    if (!isDmThreadPage()) {
      button.classList.remove("floating-active");
      if (button.parentElement !== document.body) document.body.appendChild(button);
      return button;
    }

    if (autoScrolling) {
      if (!button.classList.contains("floating-active")) {
        setFloatingActiveControlPosition(button);
      }

      button.classList.add("floating-active");
      button.classList.remove("fallback");

      if (button.parentElement !== document.body) {
        document.body.appendChild(button);
      }

      return button;
    }

    button.classList.remove("floating-active");
    button.style.removeProperty("--ig-dm-unsender-control-left");
    button.style.removeProperty("--ig-dm-unsender-control-top");
    button.style.removeProperty("--ig-dm-unsender-control-width");
    button.style.removeProperty("--ig-dm-unsender-control-height");

    placeControlInHeader(button);

    return button;
  }

  function requestRender() {
    if (rafId) return;

    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderState();
    });
  }

  function renderState() {
    injectStyle();
    ensureBlocker();
    removeLegacyVisualLayer();
    ensureControl();
    setInteractionBlocked(autoScrolling);

    if (!isDmThreadPage()) {
      clearCurrentTarget();
      clearPendingResumeTarget();
      clearSyntheticActivation();
      setInteractionBlocked(false);
    }
  }

  function looksScrollable(el) {
    if (!isVisible(el)) return false;

    const overflowY = getComputedStyle(el).overflowY;

    return (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      el.scrollHeight > el.clientHeight + 40
    );
  }

  function scoreMessagesList(el) {
    if (!isElement(el)) return -Infinity;

    let score = 0;
    const pagelet = el.getAttribute("data-pagelet") || "";

    if (pagelet === "IGDMessagesList") score += 100;
    else if (/MessagesList/i.test(pagelet)) score += 70;
    else if (/IGD/i.test(pagelet) && /Messages/i.test(pagelet)) score += 50;

    if (looksScrollable(el)) score += 25;

    score += Math.min(el.querySelectorAll('div[role="group"][tabindex="-1"]').length, 30) * 4;

    if (el.querySelector('div[role="presentation"], img, video, canvas, span')) score += 15;

    return score;
  }

  function resolveMessagesList() {
    const candidates = new Set();

    document
      .querySelectorAll('[data-pagelet="IGDMessagesList"], [data-pagelet*="MessagesList"], [data-pagelet*="IGDMessages"]')
      .forEach((el) => candidates.add(el));

    const mainRoot = document.querySelector("main") || document.body;

    candidates.add(mainRoot);

    mainRoot.querySelectorAll("div").forEach((el) => {
      if (looksScrollable(el)) candidates.add(el);
    });

    document.querySelectorAll('div[role="group"][tabindex="-1"]').forEach((row) => {
      let cur = row.parentElement;

      for (let i = 0; i < 7 && cur; i++, cur = cur.parentElement) {
        candidates.add(cur);
      }
    });

    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      const score = scoreMessagesList(el);

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best || document.querySelector('[data-pagelet="IGDMessagesList"]') || document.body;
  }

  function resolveScrollContainer(list) {
    const root = document.scrollingElement || document.documentElement;
    const candidates = [];
    let cur = list;

    while (cur && cur !== document.body) {
      if (cur.scrollHeight > cur.clientHeight + 24) candidates.push(cur);
      cur = cur.parentElement;
    }

    candidates.push(root);

    let best = root;
    let bestScore = -Infinity;

    for (const el of candidates) {
      const overflowY = getComputedStyle(el).overflowY || "";
      const canScroll = el.scrollHeight > el.clientHeight + 24;

      let score = 0;

      if (canScroll) score += 100;
      if (/(auto|scroll|overlay)/i.test(overflowY)) score += 40;
      if (el === list) score -= 60;

      score += Math.min(el === root ? window.innerHeight : el.clientHeight || 0, window.innerHeight) / 100;

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function getViewportRectForScroller(scroller) {
    const root = document.scrollingElement || document.documentElement;

    if (scroller === root || scroller === document.documentElement || scroller === document.body) {
      return {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight,
        left: 0,
        right: window.innerWidth,
        width: window.innerWidth,
      };
    }

    const r = rectOf(scroller);

    return {
      top: r.top,
      bottom: r.bottom,
      height: r.height,
      left: r.left,
      right: r.right,
      width: r.width,
    };
  }

  function getScrollerClientHeight(scroller) {
    const root = document.scrollingElement || document.documentElement;

    if (scroller === root || scroller === document.documentElement || scroller === document.body) {
      return window.innerHeight;
    }

    return scroller.clientHeight;
  }

  function getScrollerScrollTop(scroller) {
    const root = document.scrollingElement || document.documentElement;

    if (scroller === root || scroller === document.documentElement || scroller === document.body) {
      return window.scrollY || root.scrollTop || 0;
    }

    return scroller.scrollTop;
  }

  function setScrollerScrollTop(scroller, top, behavior = "auto") {
    const nextTop = Math.max(0, Math.round(top));
    const root = document.scrollingElement || document.documentElement;

    if (scroller === root || scroller === document.documentElement || scroller === document.body) {
      window.scrollTo({ top: nextTop, behavior });
    } else {
      scroller.scrollTo({ top: nextTop, behavior });
    }
  }

  function scrollScrollerBy(scroller, delta, behavior = "smooth") {
    setScrollerScrollTop(scroller, getScrollerScrollTop(scroller) + delta, behavior);
  }

  function ensureRowId(row) {
    if (!row || !row.isConnected) return "";

    if (!row.dataset.igDmMarkerRowId) {
      row.dataset.igDmMarkerRowId = String(nextSyntheticRowId++);
    }

    return row.dataset.igDmMarkerRowId;
  }

  function getRowId(row) {
    if (!row || !row.isConnected) return "";
    return row.dataset.igDmMarkerRowId || ensureRowId(row);
  }

  function findRowById(rows, id) {
    if (!id) return null;
    return rows.find((row) => getRowId(row) === id) || null;
  }

  function isSmallLinkedProfileImage(img) {
    if (!isElement(img) || (img.tagName || "").toLowerCase() !== "img" || !isVisible(img)) return false;

    const link = img.closest("a[href]");
    if (!link || !isSingleSegmentInstagramPath(link.getAttribute("href"))) return false;

    const r = rectOf(img);

    return r.width >= 20 && r.width <= 56 && r.height >= 20 && r.height <= 56;
  }

  function hasIncomingAvatar(row) {
    if (!row || !row.isConnected) return false;

    for (const img of row.querySelectorAll('a[href] img')) {
      if (isSmallLinkedProfileImage(img)) return true;
    }

    return false;
  }

  function isInsideIncomingAvatar(el) {
    if (!el || !el.isConnected) return false;

    const link = el.closest("a[href]");
    if (!link || !isSingleSegmentInstagramPath(link.getAttribute("href"))) return false;

    const img = link.querySelector("img");

    return !!img && isSmallLinkedProfileImage(img);
  }

  function isTinySquareButton(el) {
    const r = rectOf(el);
    return r.width <= 48 && r.height <= 48;
  }

  function hasVisibleHeading(el) {
    if (!el || !el.isConnected) return false;

    for (const heading of el.querySelectorAll("h1, h2")) {
      if (isVisible(heading) && textOf(heading)) return true;
    }

    return false;
  }

  function hasSingleSegmentProfileLink(el) {
    if (!el || !el.isConnected) return false;

    for (const link of el.querySelectorAll("a[href]")) {
      if (isSingleSegmentInstagramPath(link.getAttribute("href"))) return true;
    }

    return false;
  }

  function isLargeChatStartProfileImage(img) {
    if (!isElement(img) || (img.tagName || "").toLowerCase() !== "img") return false;
    if (!img.isConnected || img.closest(GROUP_ROW_SELECTOR) || isInsideIncomingAvatar(img)) return false;

    const r = rectOf(img);
    const attrWidth = Number(img.getAttribute("width")) || 0;
    const attrHeight = Number(img.getAttribute("height")) || 0;
    const width = r.width || attrWidth;
    const height = r.height || attrHeight;

    if (!width || !height) return false;
    if (width < CHAT_START_AVATAR_MIN_PX || height < CHAT_START_AVATAR_MIN_PX) return false;
    if (width > CHAT_START_AVATAR_MAX_PX || height > CHAT_START_AVATAR_MAX_PX) return false;
    if (Math.abs(width - height) > 8) return false;

    return (
      attrWidth === CHAT_START_AVATAR_EXPECTED_PX ||
      attrHeight === CHAT_START_AVATAR_EXPECTED_PX ||
      Math.abs(width - CHAT_START_AVATAR_EXPECTED_PX) <= 24
    );
  }

  function findChatStartProfileCard(list) {
    if (!list || !list.isConnected) return null;

    const imgs = list.querySelectorAll('img[width="96"][height="96"], img[height="96"][width="96"], img');

    for (const img of imgs) {
      if (!isLargeChatStartProfileImage(img)) continue;

      let cur = img.parentElement;

      for (let depth = 0; depth < CHAT_START_MAX_ANCESTOR_STEPS && cur && cur !== list; depth++, cur = cur.parentElement) {
        if (!list.contains(cur)) break;
        if (cur.matches?.(GROUP_ROW_SELECTOR)) break;
        if (!isVisible(cur)) continue;

        if (hasVisibleHeading(cur) && hasSingleSegmentProfileLink(cur)) return cur;
      }
    }

    return null;
  }

  function isInsideChatStartProfileCard(node, card) {
    return !!node && !!card && (node === card || card.contains(node));
  }

  function isChatStartProfileCardVisible(list, scroller) {
    const card = findChatStartProfileCard(list);
    if (!card || !isVisible(card)) return false;

    const viewport = getViewportRectForScroller(scroller);
    const r = rectOf(card);

    return r.bottom > viewport.top + 4 && r.top < viewport.bottom - 4;
  }

  function hasMeaningfulText(el) {
    return textOf(el).length > 0;
  }

  function hasVisibleMeaningfulTextDescendant(el) {
    for (const child of el.querySelectorAll("span, div[dir='auto'], p")) {
      if (child === el) continue;
      if (!isVisible(child)) continue;
      if (isInsideIncomingAvatar(child)) continue;
      if (child.closest("div[role='presentation']")) continue;
      if (hasMeaningfulText(child)) return true;
    }

    return false;
  }

  function isStandaloneTextPayloadLeaf(el) {
    if (!isElement(el) || !el.isConnected || !isVisible(el)) return false;
    if (isInsideIncomingAvatar(el)) return false;
    if (el.closest("button, [role='button'], a")) return false;
    if (!hasMeaningfulText(el)) return false;

    const r = rectOf(el);

    if (r.width < 4 || r.height < 8) return false;

    return !hasVisibleMeaningfulTextDescendant(el);
  }

  function getPayloadLeaves(root) {
    const raw = [];

    function add(el) {
      if (!el || !el.isConnected || !isVisible(el) || isInsideIncomingAvatar(el)) return;
      raw.push(el);
    }

    root.querySelectorAll('div[role="presentation"]').forEach((el) => {
      const r = rectOf(el);
      const hasMedia = !!el.querySelector("img, video, canvas");
      const txt = textOf(el);

      if (r.width >= 20 && r.height >= 12 && (txt || hasMedia)) add(el);
    });

    root.querySelectorAll('[role="button"]').forEach((el) => {
      if (isTinySquareButton(el)) return;
      if (!el.querySelector("img, video, canvas")) return;

      const r = rectOf(el);

      if (r.width >= 60 && r.height >= 60) add(el);
    });

    root.querySelectorAll("img, video, canvas").forEach((media) => {
      if (isInsideIncomingAvatar(media)) return;

      const r = rectOf(media);

      if (r.width < 40 || r.height < 40) return;

      add(media.closest('[role="button"], div[role="presentation"]') || media.parentElement || media);
    });

    root.querySelectorAll("span, div[dir='auto'], p, div[role='none'] span").forEach((el) => {
      if (isStandaloneTextPayloadLeaf(el)) add(el);
    });

    const uniq = [];
    const seen = new Set();

    for (const el of raw) {
      if (seen.has(el)) continue;
      seen.add(el);
      uniq.push(el);
    }

    return uniq.filter((item) => !uniq.some((other) => other !== item && other.contains(item)));
  }

  function normalizeRowNodeFromLeaf(leaf, boundary) {
    if (!leaf || !leaf.isConnected || !boundary.contains(leaf)) return null;

    const group = leaf.closest(GROUP_ROW_SELECTOR);

    if (group && boundary.contains(group) && isVisible(group)) return group;

    let cur = leaf;

    while (cur.parentElement && cur.parentElement !== boundary) {
      const parent = cur.parentElement;
      const visibleChildren = Array.from(parent.children).filter((child) => isVisible(child));

      if (visibleChildren.length !== 1) break;

      cur = parent;
    }

    return cur;
  }

  function getBasePayloadElements(row) {
    return getPayloadLeaves(row);
  }

  function rowHasMessagePayload(row) {
    if (!row || !row.isConnected) return false;

    if (row.querySelector('div[role="presentation"], img, video, canvas')) return true;

    if (row.matches(GROUP_ROW_SELECTOR) && getPayloadLeaves(row).some((el) => isStandaloneTextPayloadLeaf(el))) {
      return true;
    }

    for (const btn of row.querySelectorAll('[role="button"]')) {
      if (!isTinySquareButton(btn) && btn.querySelector('div[role="presentation"], img, video, canvas')) return true;
    }

    return false;
  }

  function isCenteredSystemLike(row, payload) {
    if (!row || !payload?.length) return false;
    if (row.matches(GROUP_ROW_SELECTOR) && hasIncomingAvatar(row)) return false;

    const union = buildUnionRect(payload);
    if (!union) return false;

    const rowRect = rectOf(row);
    const rowCenterX = rowRect.left + rowRect.width / 2;
    const payloadCenterX = (union.left + union.right) / 2;
    const offset = Math.abs(payloadCenterX - rowCenterX);
    const threshold = Math.min(90, Math.max(28, rowRect.width * 0.12));

    return offset <= threshold;
  }

  function isEmojiLikeText(value) {
    const text = String(value || "");

    try {
      return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(text);
    } catch {
      return /[\u{1F300}-\u{1FAFF}]/u.test(text);
    }
  }

  function hasEmojiOnlyPayload(row, payload) {
    if (!row || !payload?.length) return false;
    if (!row.matches(GROUP_ROW_SELECTOR)) return false;

    const text = payload.map((el) => textOf(el)).join("").trim();

    if (!text) return false;
    if (text.length > 24) return false;

    return isEmojiLikeText(text);
  }

  function hasOutgoingSpacerSignature(row) {
    if (!row || !row.isConnected) return false;
    if (hasIncomingAvatar(row)) return false;

    const widths = Array.from(row.querySelectorAll('[style*="--x-width"]'))
      .map((el) => {
        const style = el.getAttribute("style") || "";
        const match = style.match(/--x-width\s*:\s*([0-9.]+)px/i);
        return match ? Number(match[1]) : NaN;
      })
      .filter((num) => Number.isFinite(num));

    return widths.some((width) => width >= 80) && widths.some((width) => width <= 24);
  }

  function isSystemRow(row, payload = null) {
    if (!row || !row.isConnected) return false;

    const base = payload || getBasePayloadElements(row);

    if (!base.length) return false;
    if (hasEmojiOnlyPayload(row, base)) return false;
    if (rowHasMessagePayload(row) && !isCenteredSystemLike(row, base)) return false;

    const hasVisibleText = base.some((el) => hasMeaningfulText(el));

    if (!hasVisibleText) return false;

    return isCenteredSystemLike(row, base) && !row.querySelector('div[role="presentation"], img, video, canvas');
  }

  function isCandidateRow(row) {
    if (!isVisible(row)) return false;

    const payload = getBasePayloadElements(row);

    if (!payload.length) return false;

    for (const nested of row.querySelectorAll(GROUP_ROW_SELECTOR)) {
      if (nested !== row && isVisible(nested)) return false;
    }

    return true;
  }

  function sortInDomOrder(nodes) {
    return [...nodes].sort((a, b) => {
      if (a === b) return 0;

      const rel = a.compareDocumentPosition(b);

      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;

      return 0;
    });
  }

  function getCandidateRows(boundary) {
    const rows = new Set();
    const chatStartCard = findChatStartProfileCard(boundary);

    boundary.querySelectorAll(GROUP_ROW_SELECTOR).forEach((row) => {
      if (!isInsideChatStartProfileCard(row, chatStartCard) && isCandidateRow(row)) rows.add(row);
    });

    for (const leaf of getPayloadLeaves(boundary)) {
      if (isInsideChatStartProfileCard(leaf, chatStartCard)) continue;

      const row = normalizeRowNodeFromLeaf(leaf, boundary);

      if (row && row !== boundary && !isInsideChatStartProfileCard(row, chatStartCard) && isCandidateRow(row)) rows.add(row);
    }

    const ordered = sortInDomOrder(rows);

    const filtered = ordered.filter((row) => {
      if (isInsideChatStartProfileCard(row, chatStartCard)) return false;

      return !ordered.some((other) => other !== row && row.contains(other) && isCandidateRow(other));
    });

    filtered.forEach(ensureRowId);

    return filtered;
  }

  function getRowsInDomOrder(list) {
    return getCandidateRows(list);
  }

  function buildUnionRect(elements) {
    if (!elements.length) return null;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const el of elements) {
      const r = rectOf(el);

      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }

    if (!isFinite(left) || !isFinite(top) || !isFinite(right) || !isFinite(bottom)) return null;

    return { left, top, right, bottom };
  }

  function classifyRow(row, payload) {
    if (isSystemRow(row, payload)) return "other";
    if (hasIncomingAvatar(row)) return "other";

    if (hasOutgoingSpacerSignature(row) && hasEmojiOnlyPayload(row, payload)) return "mine";

    const union = buildUnionRect(payload);

    if (!union) return null;

    const rowRect = rectOf(row);
    const rowCenterX = rowRect.left + rowRect.width / 2;
    const payloadCenterX = (union.left + union.right) / 2;
    const leftGap = Math.max(0, union.left - rowRect.left);
    const rightGap = Math.max(0, rowRect.right - union.right);

    if (rightGap + 24 < leftGap) return "mine";
    if (leftGap + 24 < rightGap) return "other";

    return payloadCenterX > rowCenterX ? "mine" : "other";
  }

  function getRowType(row) {
    if (!row || !row.isConnected) return null;

    const payload = getBasePayloadElements(row);

    if (!payload.length) return null;

    return classifyRow(row, payload);
  }

  function getRowSignature(row) {
    if (!row || !row.isConnected) return "";

    const payload = getBasePayloadElements(row);

    const text = payload
      .map((el) => textOf(el))
      .filter(Boolean)
      .join(" | ")
      .slice(0, 220);

    const mediaSummary = payload
      .map((el) => {
        const r = rectOf(el);
        return `${(el.tagName || "").toLowerCase()}:${Math.round(r.width)}x${Math.round(r.height)}`;
      })
      .join("|")
      .slice(0, 160);

    const rowRect = rectOf(row);
    const kind = isSystemRow(row, payload) ? "system" : "message";

    return `${kind}::${getRowType(row) || "unknown"}::${Math.round(rowRect.width)}x${Math.round(rowRect.height)}::${text}::${mediaSummary}`;
  }

  function getRowIdentityKey(row) {
    if (!row || !row.isConnected) return "";
    return getRowId(row) || getRowSignature(row);
  }

  function getRowViewportTop(row) {
    return row && row.isConnected ? rectOf(row).top : NaN;
  }

  function getRowViewportCenter(row) {
    if (!row || !row.isConnected) return NaN;

    const r = rectOf(row);

    return r.top + r.height / 2;
  }

  function setCurrentTarget(row, type = null) {
    if (!row || !row.isConnected) {
      clearCurrentTarget();
      return;
    }

    currentTargetRow = row;
    currentTargetRowId = getRowId(row);
    currentTargetType = type || getRowType(row);
    currentTargetSignature = getRowSignature(row);
    currentTargetViewportTop = getRowViewportTop(row);
    currentTargetViewportCenter = getRowViewportCenter(row);
  }

  function setCurrentTargetIdentity({
    rowId = "",
    signature = "",
    type = null,
    viewportTop = NaN,
    viewportCenter = NaN,
  } = {}) {
    currentTargetRow = null;
    currentTargetRowId = rowId || "";
    currentTargetType = type || null;
    currentTargetSignature = signature || "";
    currentTargetViewportTop = Number.isFinite(viewportTop) ? viewportTop : NaN;
    currentTargetViewportCenter = Number.isFinite(viewportCenter) ? viewportCenter : NaN;
  }

  function clearCurrentTarget() {
    currentTargetRow = null;
    currentTargetRowId = "";
    currentTargetType = null;
    currentTargetSignature = "";
    currentTargetViewportTop = NaN;
    currentTargetViewportCenter = NaN;
  }

  function snapshotRow(row) {
    if (!row || !row.isConnected) return null;

    return {
      row,
      rowId: getRowId(row),
      signature: getRowSignature(row),
      type: getRowType(row),
      viewportTop: getRowViewportTop(row),
      viewportCenter: getRowViewportCenter(row),
    };
  }

  function resolveRowSnapshot(rows, snapshot) {
    if (!snapshot) return null;
    if (snapshot.row && snapshot.row.isConnected) return snapshot.row;

    const byId = findRowById(rows, snapshot.rowId);
    if (byId) return byId;

    return findBestRowBySignature(rows, snapshot.signature, snapshot.viewportTop, snapshot.viewportCenter);
  }

  function queueResumeTarget(snapshot) {
    pendingResumeTarget = snapshot || null;
  }

  function clearPendingResumeTarget() {
    pendingResumeTarget = null;
  }

  function snapshotPreviousRowForResume(row) {
    if (!row || !row.isConnected) return null;

    const list = resolveMessagesList();
    const rows = getRowsInDomOrder(list);
    const previousRow = getPreviousRowByDomOrder(rows, row, list);

    if (!previousRow) return null;

    const chatStartCard = findChatStartProfileCard(list);
    if (isInsideChatStartProfileCard(previousRow, chatStartCard)) return null;

    return snapshotRow(previousRow);
  }

  async function restoreResumeTargetPosition(snapshot, runId) {
    if (!snapshot || !autoScrolling || runId !== autoScrollRunId) return false;

    await wait(120);

    const list = resolveMessagesList();
    const rows = getRowsInDomOrder(list);
    const row = resolveRowSnapshot(rows, snapshot);

    if (!row || !row.isConnected) return false;

    setCurrentTarget(row, getRowType(row));

    const scroller = resolveScrollContainer(list);

    row.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });

    await waitForScrollIdle(scroller);
    requestRender();

    return true;
  }

  async function handlePendingResumeTarget(list, scroller, rows, runId) {
    if (!pendingResumeTarget) return false;

    const snapshot = pendingResumeTarget;
    let row = resolveRowSnapshot(rows, snapshot);

    if (!row || !row.isConnected) {
      const restored = await restoreResumeTargetPosition(snapshot, runId);

      if (restored) {
        const freshList = resolveMessagesList();
        const freshRows = getRowsInDomOrder(freshList);
        row = resolveRowSnapshot(freshRows, snapshot);
      }
    }

    if (!row || !row.isConnected) {
      pendingResumeTarget = null;
      return false;
    }

    pendingResumeTarget = null;

    setCurrentTarget(row, getRowType(row));
    requestRender();

    row.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });

    await waitForScrollIdle(scroller);
    await wait(60);

    const freshList = resolveMessagesList();
    const freshRows = getRowsInDomOrder(freshList);
    const resolved = resolveRowSnapshot(freshRows, snapshot) || (row.isConnected ? row : null);

    if (resolved) {
      setCurrentTarget(resolved, getRowType(resolved));
      requestRender();

      const ok = await pauseOnMineRowIfNeeded(resolved, runId);
      if (!ok) return true;
    }

    return true;
  }

  function rowIntersectsViewport(row, viewportRect) {
    const r = rectOf(row);
    return r.bottom > viewportRect.top + 8 && r.top < viewportRect.bottom - 8;
  }

  function getVisibleRows(rows, viewportRect) {
    return rows.filter((row) => rowIntersectsViewport(row, viewportRect));
  }

  function getNewestVisibleRow(rows, viewportRect) {
    const visibleRows = getVisibleRows(rows, viewportRect);
    return visibleRows.length ? visibleRows[visibleRows.length - 1] : null;
  }

  function findBestRowBySignature(rows, signature, approxTop = NaN, approxCenter = NaN) {
    if (!signature) return null;

    const matches = rows.filter((row) => getRowSignature(row) === signature);

    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];

    let best = matches[0];
    let bestScore = Infinity;

    for (const row of matches) {
      const r = rectOf(row);
      let score = 0;

      if (Number.isFinite(approxTop)) score += Math.abs(r.top - approxTop) * 3;
      if (Number.isFinite(approxCenter)) score += Math.abs(r.top + r.height / 2 - approxCenter) * 2;
      if (!Number.isFinite(approxTop) && !Number.isFinite(approxCenter)) score += Math.abs(r.top + r.height / 2 - window.innerHeight * 0.6);

      if (score < bestScore) {
        bestScore = score;
        best = row;
      }
    }

    return best;
  }

  function hasLockedCurrentTarget(rows, viewportRect) {
    const idMatch = findRowById(rows, currentTargetRowId);
    if (idMatch && rowIntersectsViewport(idMatch, viewportRect)) return true;

    if (currentTargetRow && currentTargetRow.isConnected && rowIntersectsViewport(currentTargetRow, viewportRect)) return true;

    const signatureMatch = findBestRowBySignature(rows, currentTargetSignature, currentTargetViewportTop, currentTargetViewportCenter);

    return !!(signatureMatch && rowIntersectsViewport(signatureMatch, viewportRect));
  }

  function getStepBaseRow(rows, viewportRect) {
    const idMatch = findRowById(rows, currentTargetRowId);
    if (idMatch && rowIntersectsViewport(idMatch, viewportRect)) return idMatch;

    if (currentTargetRow && currentTargetRow.isConnected && rowIntersectsViewport(currentTargetRow, viewportRect)) return currentTargetRow;

    const signatureMatch = findBestRowBySignature(rows, currentTargetSignature, currentTargetViewportTop, currentTargetViewportCenter);
    if (signatureMatch && rowIntersectsViewport(signatureMatch, viewportRect)) return signatureMatch;

    return getNewestVisibleRow(rows, viewportRect);
  }

  function findLastCandidateRowInSubtree(node) {
    if (!node || !node.isConnected) return null;

    const matches = getCandidateRows(node);
    return matches.length ? matches[matches.length - 1] : null;
  }

  function getPreviousRowByDomClimb(list, row) {
    if (!list || !row || !row.isConnected) return null;

    let cur = row;

    while (cur && cur !== list) {
      let prev = cur.previousElementSibling;

      while (prev) {
        const found = findLastCandidateRowInSubtree(prev);
        if (found) return found;
        prev = prev.previousElementSibling;
      }

      cur = cur.parentElement;
    }

    return null;
  }

  function getPreviousRowByDomOrder(rows, row, list) {
    if (!row) return null;

    const idx = rows.indexOf(row);
    if (idx > 0) return rows[idx - 1];

    let previous = null;

    for (const candidate of rows) {
      if (candidate === row) continue;

      const rel = candidate.compareDocumentPosition(row);
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) previous = candidate;
    }

    return previous || getPreviousRowByDomClimb(list, row);
  }

  function rememberStyle(el, prop) {
    if (!el.__igDmStore) el.__igDmStore = {};
    if (!(prop in el.__igDmStore)) el.__igDmStore[prop] = el.style.getPropertyValue(prop);
  }

  function chooseDisplayValue(el) {
    if (!el || !(el instanceof Element)) return "block";
    if (el.matches("button, [role='button'], a")) return "inline-flex";
    if (el.matches("svg")) return "block";
    return "flex";
  }

  function isHiddenish(el) {
    if (!el || !el.isConnected) return false;

    const cs = getComputedStyle(el);
    const r = rectOf(el);

    return (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      Number(cs.opacity) < 0.95 ||
      cs.pointerEvents === "none" ||
      r.width === 0 ||
      r.height === 0
    );
  }

  function revealNode(el) {
    if (!el || !el.isConnected) return;
    if (!revealedNodes.includes(el)) revealedNodes.push(el);

    for (const prop of ["display", "visibility", "opacity", "pointer-events", "max-width", "max-height", "width", "height"]) {
      rememberStyle(el, prop);
    }

    const cs = getComputedStyle(el);

    if (cs.display === "none") el.style.setProperty("display", chooseDisplayValue(el), "important");

    el.style.setProperty("visibility", "visible", "important");
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("pointer-events", "auto", "important");

    if (rectOf(el).width === 0) {
      el.style.setProperty("width", "auto", "important");
      el.style.setProperty("max-width", "none", "important");
    }

    if (rectOf(el).height === 0) {
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
    }
  }

  function restoreRevealedNodes() {
    for (const el of revealedNodes) {
      if (!el || !el.isConnected || !el.__igDmStore) continue;

      for (const [prop, value] of Object.entries(el.__igDmStore)) {
        if (value) el.style.setProperty(prop, value);
        else el.style.removeProperty(prop);
      }

      delete el.__igDmStore;
    }

    revealedNodes = [];
  }

  function focusRow(row) {
    if (!row || !row.isConnected) return;
    if (!modifiedRows.includes(row)) modifiedRows.push(row);

    if (!row.__igDmOriginalTabindex) row.__igDmOriginalTabindex = row.getAttribute("tabindex");
    if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");

    row.setAttribute("data-ig-dm-active-row", "1");

    try {
      row.focus({ preventScroll: true });
    } catch {
      try {
        row.focus();
      } catch {}
    }
  }

  function clearFocusedRows() {
    for (const row of modifiedRows) {
      if (!row || !row.isConnected) continue;

      row.removeAttribute("data-ig-dm-active-row");
      row.removeAttribute("data-ig-dm-hover-row");

      if (row.__igDmOriginalTabindex === null) row.removeAttribute("tabindex");
      else if (typeof row.__igDmOriginalTabindex === "string") row.setAttribute("tabindex", row.__igDmOriginalTabindex);

      delete row.__igDmOriginalTabindex;
    }

    modifiedRows = [];
  }

  function findControlCandidates(row) {
    if (!row || !row.isConnected) return [];

    const out = new Set();

    row.querySelectorAll('[role="button"], button, a, [aria-label], [tabindex]').forEach((el) => {
      if (isInsideIncomingAvatar(el)) return;

      out.add(el);

      let cur = el.parentElement;

      while (cur && cur !== row.parentElement) {
        out.add(cur);
        if (cur === row) break;
        cur = cur.parentElement;
      }
    });

    row.querySelectorAll("*").forEach((el) => {
      if (isInsideIncomingAvatar(el)) return;

      const cs = getComputedStyle(el);

      if (
        isHiddenish(el) &&
        (el.querySelector('[role="button"], button, a, [aria-label], [tabindex]') ||
          cs.position === "absolute" ||
          cs.position === "fixed")
      ) {
        out.add(el);

        let cur = el.parentElement;

        while (cur && cur !== row.parentElement) {
          out.add(cur);
          if (cur === row) break;
          cur = cur.parentElement;
        }
      }
    });

    return [...out];
  }

  function focusBestInnerControl(row) {
    if (!row || !row.isConnected) return;

    const candidates = row.querySelectorAll('[role="button"], button, a, [tabindex]:not([tabindex="-1"])');

    for (const el of candidates) {
      if (!isVisible(el) || isInsideIncomingAvatar(el)) continue;

      try {
        el.focus({ preventScroll: true });
        return;
      } catch {}
    }
  }

  function getElementCenterPoint(el) {
    const r = rectOf(el);

    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  }

  function getUnionCenterPoint(elements, fallback) {
    const union = buildUnionRect(elements);
    if (!union) return getElementCenterPoint(fallback);

    return {
      x: Math.round((union.left + union.right) / 2),
      y: Math.round((union.top + union.bottom) / 2),
    };
  }

  function dispatchMouseLikeEvent(target, type, point, extra = {}) {
    if (!target || !target.isConnected) return false;

    const init = {
      bubbles: !/enter|leave/i.test(type),
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      screenX: point.x,
      screenY: point.y,
      button: 0,
      buttons: /down/i.test(type) ? 1 : 0,
      ...extra,
    };

    try {
      const docWindow = target.ownerDocument?.defaultView;

      if (/^pointer/i.test(type) && typeof (docWindow?.PointerEvent || PointerEvent) === "function") {
        const PointerEventCtor = docWindow?.PointerEvent || PointerEvent;
        target.dispatchEvent(new PointerEventCtor(type, {
          ...init,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }));
      } else {
        const MouseEventCtor = docWindow?.MouseEvent || MouseEvent;
        target.dispatchEvent(new MouseEventCtor(type, init));
      }

      return true;
    } catch (error) {
      logWarn(`Event dispatch failed for ${type}`, describeElement(target), error);
      return false;
    }
  }

  function hoverRow(row) {
    if (!row || !row.isConnected) return false;
    if (!modifiedRows.includes(row)) modifiedRows.push(row);

    row.setAttribute("data-ig-dm-hover-row", "1");

    const payload = getBasePayloadElements(row);
    const target = payload.length ? payload[0] : row;
    const point = payload.length ? getUnionCenterPoint(payload, row) : getElementCenterPoint(row);

    for (const el of [row, target]) {
      if (!el || !el.isConnected) continue;

      dispatchMouseLikeEvent(el, "pointerover", point, { relatedTarget: document.body });
      dispatchMouseLikeEvent(el, "pointerenter", point, { relatedTarget: document.body });
      dispatchMouseLikeEvent(el, "mouseover", point, { relatedTarget: document.body });
      dispatchMouseLikeEvent(el, "mouseenter", point, { relatedTarget: document.body });
      dispatchMouseLikeEvent(el, "pointermove", point);
      dispatchMouseLikeEvent(el, "mousemove", point);
    }

    return true;
  }

  function parseNumberAttr(el, attr) {
    const value = Number(el.getAttribute(attr));
    return Number.isFinite(value) ? value : NaN;
  }

  function isStaticThreeVerticalDotsSvg(svg) {
    if (!isElement(svg) || (svg.tagName || "").toLowerCase() !== "svg") return false;

    const viewBox = (svg.getAttribute("viewBox") || "").trim().replace(/\s+/g, " ");
    if (viewBox && viewBox !== "0 0 24 24") return false;

    const circles = Array.from(svg.querySelectorAll("circle"));
    if (circles.length !== 3) return false;

    const points = circles
      .map((circle) => ({
        cx: parseNumberAttr(circle, "cx"),
        cy: parseNumberAttr(circle, "cy"),
        r: parseNumberAttr(circle, "r"),
      }))
      .sort((a, b) => a.cy - b.cy);

    const expectedY = [6, 12, 18];

    return points.every((point, index) => {
      return (
        Math.abs(point.cx - 12) <= 0.75 &&
        Math.abs(point.cy - expectedY[index]) <= 0.75 &&
        Math.abs(point.r - 1.5) <= 0.75
      );
    });
  }

  function hasStaticThreeVerticalDotsIcon(el) {
    if (!el || !el.isConnected) return false;

    if ((el.tagName || "").toLowerCase() === "svg" && isStaticThreeVerticalDotsSvg(el)) return true;

    for (const svg of el.querySelectorAll("svg")) {
      if (isStaticThreeVerticalDotsSvg(svg)) return true;
    }

    return false;
  }

  function compactPathData(d) {
    return String(d || "").replace(/[\s,]+/g, "");
  }

  function isStaticUnsendSvg(svg) {
    if (!isElement(svg) || (svg.tagName || "").toLowerCase() !== "svg") return false;

    const viewBox = (svg.getAttribute("viewBox") || "").trim().replace(/\s+/g, " ");
    if (viewBox !== "0 0 24 24") return false;

    const paths = Array.from(svg.querySelectorAll("path")).map((path) => compactPathData(path.getAttribute("d")));
    if (paths.length < 2) return false;

    const hasOuterCirclePath = paths.some((d) => {
      return (
        d.includes("M12.5C5.659.5.55.66.512S5.65923.51223.5") &&
        d.includes("11.5-11.5S18.34.512.5")
      );
    });

    const hasBackArrowPath = paths.some((d) => {
      return (
        d.includes("M14.510H9.414l1.293-1.293") &&
        d.includes("C1811.57116.431014.510")
      );
    });

    return hasOuterCirclePath && hasBackArrowPath;
  }

  function hasStaticUnsendIcon(el) {
    if (!el || !el.isConnected) return false;

    if ((el.tagName || "").toLowerCase() === "svg" && isStaticUnsendSvg(el)) return true;

    for (const svg of el.querySelectorAll("svg")) {
      if (isStaticUnsendSvg(svg)) return true;
    }

    return false;
  }

  function hasUsableHitRect(el) {
    if (!el || !el.isConnected) return false;

    const r = rectOf(el);
    const cs = getComputedStyle(el);

    return r.width >= 10 && r.height >= 10 && cs.display !== "none" && cs.visibility !== "hidden";
  }

  function isStaticMoreMenuButton(el) {
    if (!isElement(el) || !el.isConnected) return false;
    if (isInsideIncomingAvatar(el)) return false;
    if (el.closest('[role="menu"]')) return false;

    const role = (el.getAttribute("role") || "").toLowerCase();
    const tag = (el.tagName || "").toLowerCase();
    const hasMenuPopup = (el.getAttribute("aria-haspopup") || "").toLowerCase() === "menu";

    if (role !== "button" && tag !== "button") return false;
    if (!hasMenuPopup || !hasStaticThreeVerticalDotsIcon(el)) return false;

    const r = rectOf(el);
    return r.width <= 80 && r.height <= 80;
  }

  function getMoreButtonSearchRoots(row) {
    const roots = [];
    const seen = new Set();

    function add(root) {
      if (!root || !root.isConnected || seen.has(root)) return;
      seen.add(root);
      roots.push(root);
    }

    add(row);

    let cur = row?.parentElement || null;

    for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
      add(cur);
    }

    add(resolveMessagesList());

    return roots;
  }

  function revealButtonPath(button, maxSteps = 8) {
    if (!button || !button.isConnected) return;

    let cur = button;
    let steps = 0;

    while (cur && cur.isConnected && steps < maxSteps) {
      revealNode(cur);
      cur = cur.parentElement;
      steps++;
    }

    button.querySelectorAll("svg, circle, path").forEach(revealNode);
  }

  function revealMoreButtonPath(button, row) {
    if (!button || !button.isConnected) return;

    let cur = button;
    let steps = 0;

    while (cur && cur.isConnected && steps < 8) {
      revealNode(cur);
      if (cur === row) break;
      cur = cur.parentElement;
      steps++;
    }

    button.querySelectorAll("svg, circle").forEach(revealNode);
  }

  function scoreMoreButtonForRow(button, row) {
    const buttonRect = rectOf(button);
    const rowRect = rectOf(row);
    const payload = getBasePayloadElements(row);
    const payloadRect = buildUnionRect(payload);

    const buttonCenterX = buttonRect.left + buttonRect.width / 2;
    const buttonCenterY = buttonRect.top + buttonRect.height / 2;
    const rowCenterY = rowRect.top + rowRect.height / 2;

    let score = 0;

    if (row.contains(button)) score += 1000;
    if (hasUsableHitRect(button)) score += 140;
    if (isVisible(button)) score += 80;

    const verticalOverlap = Math.min(buttonRect.bottom, rowRect.bottom) - Math.max(buttonRect.top, rowRect.top);
    if (verticalOverlap > 0) score += 320;

    score -= Math.abs(buttonCenterY - rowCenterY) * 4;

    if (payloadRect) {
      const payloadCenterY = (payloadRect.top + payloadRect.bottom) / 2;
      const nearestPayloadEdgeX = Math.min(
        Math.abs(buttonCenterX - payloadRect.left),
        Math.abs(buttonCenterX - payloadRect.right)
      );

      score -= Math.abs(buttonCenterY - payloadCenterY) * 2;
      score -= Math.min(nearestPayloadEdgeX, 240);

      if (buttonCenterY >= payloadRect.top - 28 && buttonCenterY <= payloadRect.bottom + 28) score += 160;
      if (getRowType(row) === "mine" && buttonCenterX <= payloadRect.left + 24) score += 90;
    }

    return score;
  }

  function getScoredMoreButtonCandidatesForRow(row) {
    if (!row || !row.isConnected) return [];

    const candidates = new Set();

    for (const root of getMoreButtonSearchRoots(row)) {
      root.querySelectorAll('[role="button"][aria-haspopup="menu"], button[aria-haspopup="menu"]').forEach((el) => {
        if (isStaticMoreMenuButton(el)) candidates.add(el);
      });
    }

    return [...candidates]
      .filter((button) => hasUsableHitRect(button) || isHiddenish(button) || isVisible(button))
      .map((button) => ({
        button,
        score: scoreMoreButtonForRow(button, row),
      }))
      .sort((a, b) => b.score - a.score);
  }

  function findMoreButtonForRow(row) {
    const scored = getScoredMoreButtonCandidatesForRow(row);
    return scored.length ? scored[0].button : null;
  }

  async function waitForMoreButton(row, runId, timeoutMs = MORE_BUTTON_DISCOVERY_TIMEOUT_MS) {
    const started = performance.now();
    let lastCandidate = null;

    while (performance.now() - started < timeoutMs) {
      if (!autoScrolling || runId !== autoScrollRunId) return null;
      if (!row || !row.isConnected) return null;

      pulseActiveRow();
      hoverRow(row);

      const candidate = findMoreButtonForRow(row);

      if (candidate) {
        lastCandidate = candidate;
        revealMoreButtonPath(candidate, row);

        if (hasUsableHitRect(candidate) || isVisible(candidate)) return candidate;
      }

      await wait(50);
    }

    if (lastCandidate) revealMoreButtonPath(lastCandidate, row);

    return lastCandidate;
  }

  function getVisibleMenuLikeElements() {
    return Array.from(document.querySelectorAll('[role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')).filter(isVisible);
  }

  function getExpandedMenuButtons() {
    return Array.from(document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]')).filter(isVisible);
  }

  function getVisibleDialogLikeElements() {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter((el) => {
      return isVisible(el) && !el.closest('[role="menu"]');
    });
  }

  function getMenuSnapshot() {
    return {
      menuLikeCount: getVisibleMenuLikeElements().length,
      expandedMenuButtonCount: getExpandedMenuButtons().length,
    };
  }

  function getDialogSnapshot() {
    return {
      dialogCount: getVisibleDialogLikeElements().length,
    };
  }

  function getMenuOpenState(button, beforeSnapshot = null) {
    const menuLike = getVisibleMenuLikeElements();
    const expandedButtons = getExpandedMenuButtons();

    if (button && button.isConnected && button.getAttribute("aria-expanded") === "true") {
      return {
        open: true,
        reason: "target button aria-expanded=true",
        menuLikeCount: menuLike.length,
        expandedMenuButtonCount: expandedButtons.length,
      };
    }

    if (beforeSnapshot && expandedButtons.length > beforeSnapshot.expandedMenuButtonCount) {
      return {
        open: true,
        reason: "new expanded menu button",
        menuLikeCount: menuLike.length,
        expandedMenuButtonCount: expandedButtons.length,
      };
    }

    if (beforeSnapshot && menuLike.length > beforeSnapshot.menuLikeCount) {
      return {
        open: true,
        reason: "new menu/menuitem appeared",
        menuLikeCount: menuLike.length,
        expandedMenuButtonCount: expandedButtons.length,
      };
    }

    return {
      open: false,
      reason: "no expanded target/new visible menu detected",
      menuLikeCount: menuLike.length,
      expandedMenuButtonCount: expandedButtons.length,
    };
  }

  async function waitForMenuOpenAfterNativeClick(button, beforeSnapshot, timeoutMs = MENU_OPEN_VERIFY_TIMEOUT_MS) {
    const started = performance.now();
    let lastState = getMenuOpenState(button, beforeSnapshot);

    while (performance.now() - started < timeoutMs) {
      lastState = getMenuOpenState(button, beforeSnapshot);
      if (lastState.open) return lastState;
      await wait(80);
    }

    return lastState;
  }

  function focusElementNoScroll(el) {
    if (!el || !el.isConnected) return false;

    try {
      el.focus({ preventScroll: true });
      return true;
    } catch {
      try {
        el.focus();
        return true;
      } catch {
        return false;
      }
    }
  }

  function getUnsendButtonAncestorForSvg(svg) {
    if (!svg || !svg.isConnected) return null;

    let cur = svg;

    for (let steps = 0; steps < 10 && cur; steps++, cur = cur.parentElement) {
      if (!isElement(cur)) continue;

      const role = (cur.getAttribute("role") || "").toLowerCase();
      const tag = (cur.tagName || "").toLowerCase();

      const isButtonish =
        role === "button" ||
        role === "menuitem" ||
        role === "menuitemradio" ||
        role === "menuitemcheckbox" ||
        tag === "button";

      if (!isButtonish) continue;
      if (!hasStaticUnsendIcon(cur)) continue;
      if (!hasUsableHitRect(cur) && !isVisible(cur)) continue;

      return cur;
    }

    return null;
  }

  function scoreUnsendButton(button) {
    if (!button || !button.isConnected) return -Infinity;

    const r = rectOf(button);
    const role = (button.getAttribute("role") || "").toLowerCase();
    const tag = (button.tagName || "").toLowerCase();

    let score = 0;

    if (hasStaticUnsendIcon(button)) score += 1000;
    if (isVisible(button)) score += 240;
    if (hasUsableHitRect(button)) score += 160;
    if (role === "button") score += 90;
    if (role.startsWith("menuitem")) score += 110;
    if (tag === "button") score += 90;
    if (r.width >= 100) score += 80;
    if (r.height >= 24 && r.height <= 72) score += 80;
    if (currentTargetRow && !currentTargetRow.contains(button)) score += 80;

    const svg = button.querySelector("svg");

    if (svg) {
      const sr = rectOf(svg);
      if (sr.width >= 14 && sr.width <= 28 && sr.height >= 14 && sr.height <= 28) score += 80;
    }

    const centerY = r.top + r.height / 2;

    if (centerY >= 0 && centerY <= window.innerHeight) score += 40;

    return score;
  }

  function getScoredUnsendButtonCandidates() {
    const candidates = new Set();

    document.querySelectorAll('svg[viewBox="0 0 24 24"]').forEach((svg) => {
      if (!isStaticUnsendSvg(svg)) return;

      const button = getUnsendButtonAncestorForSvg(svg);

      if (button) candidates.add(button);
    });

    return [...candidates]
      .filter((button) => button && button.isConnected && hasStaticUnsendIcon(button) && (hasUsableHitRect(button) || isVisible(button)))
      .map((button) => ({
        button,
        score: scoreUnsendButton(button),
      }))
      .sort((a, b) => b.score - a.score);
  }

  function findUnsendButton() {
    const scored = getScoredUnsendButtonCandidates();
    return scored.length ? scored[0].button : null;
  }

  async function waitForUnsendButton(runId, timeoutMs = UNSEND_BUTTON_DISCOVERY_TIMEOUT_MS) {
    const started = performance.now();
    let lastCandidate = null;

    while (performance.now() - started < timeoutMs) {
      if (!autoScrolling || runId !== autoScrollRunId) return null;

      const candidate = findUnsendButton();

      if (candidate) {
        lastCandidate = candidate;
        revealButtonPath(candidate);

        if (hasUsableHitRect(candidate) || isVisible(candidate)) return candidate;
      }

      await wait(50);
    }

    if (lastCandidate) revealButtonPath(lastCandidate);

    return lastCandidate;
  }

  function parseRgbColor(value) {
    const match = String(value || "").trim().match(/^rgba?\(([^)]+)\)$/i);
    if (!match) return null;

    const parts = match[1]
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((num) => Number.isFinite(num));

    if (parts.length < 3) return null;

    return {
      r: parts[0],
      g: parts[1],
      b: parts[2],
      a: parts.length >= 4 ? parts[3] : 1,
    };
  }

  function isDestructiveColorValue(value) {
    const rgb = parseRgbColor(value);
    if (!rgb || rgb.a === 0) return false;

    return (
      rgb.r >= 170 &&
      rgb.g <= 140 &&
      rgb.b <= 160 &&
      rgb.r - rgb.g >= 45 &&
      rgb.r - rgb.b >= 35
    );
  }

  function hasDestructiveVisualStyle(el) {
    if (!el || !el.isConnected) return false;

    const cs = getComputedStyle(el);

    return (
      isDestructiveColorValue(cs.color) ||
      isDestructiveColorValue(cs.backgroundColor) ||
      isDestructiveColorValue(cs.borderTopColor) ||
      isDestructiveColorValue(cs.borderRightColor) ||
      isDestructiveColorValue(cs.borderBottomColor) ||
      isDestructiveColorValue(cs.borderLeftColor)
    );
  }

  function getDialogRank(dialog) {
    if (!dialog || !dialog.isConnected) return -Infinity;

    const r = rectOf(dialog);
    const z = Number.parseInt(getComputedStyle(dialog).zIndex, 10);

    let score = 0;

    if (dialog.getAttribute("aria-modal") === "true") score += 1000;
    if ((dialog.getAttribute("role") || "").toLowerCase() === "dialog") score += 800;
    if (Number.isFinite(z)) score += Math.min(Math.max(z, 0), 2147483647) / 1000000;
    if (r.width >= 240 && r.height >= 120) score += 200;

    if (r.left >= -10 && r.top >= -10 && r.right <= window.innerWidth + 10 && r.bottom <= window.innerHeight + 10) score += 120;

    return score;
  }

  function getVisibleDialogsRanked() {
    return getVisibleDialogLikeElements().sort((a, b) => getDialogRank(b) - getDialogRank(a));
  }

  function isPossibleFinalConfirmButton(button, dialog) {
    if (!isElement(button) || !button.isConnected) return false;
    if (!dialog || !dialog.contains(button)) return false;
    if (!isVisible(button)) return false;
    if (button.id === CONTROL_ID) return false;
    if (button.closest('[role="menu"]')) return false;
    if (button.disabled) return false;
    if ((button.tagName || "").toLowerCase() !== "button") return false;

    const r = rectOf(button);

    if (r.width < 60 || r.height < 24) return false;
    if (r.width > Math.max(window.innerWidth, 1200)) return false;
    if (r.height > 120) return false;
    if (!textOf(button)) return false;
    if (button.querySelector("svg, img, video, canvas")) return false;

    return true;
  }

  function scoreFinalConfirmButton(button, dialog) {
    if (!button || !button.isConnected) return -Infinity;

    const buttonRect = rectOf(button);
    const dialogRect = rectOf(dialog);
    const cs = getComputedStyle(button);

    let score = 0;

    if (hasDestructiveVisualStyle(button)) score += 1500;
    if (isVisible(button)) score += 260;
    if (hasUsableHitRect(button)) score += 180;
    if ((button.tagName || "").toLowerCase() === "button") score += 220;
    if (button.getAttribute("tabindex") === "0") score += 90;
    if (textOf(button)) score += 60;
    if (!button.querySelector("svg, img, video, canvas")) score += 90;
    if (buttonRect.width >= 90) score += 80;
    if (buttonRect.height >= 28 && buttonRect.height <= 72) score += 120;
    if (buttonRect.top >= dialogRect.top + dialogRect.height * 0.45) score += 80;

    const centerX = buttonRect.left + buttonRect.width / 2;

    if (centerX >= dialogRect.left && centerX <= dialogRect.right) score += 40;

    const fontWeight = Number.parseInt(cs.fontWeight, 10);

    if (Number.isFinite(fontWeight) && fontWeight >= 500) score += 30;

    return score;
  }

  function getScoredFinalConfirmButtonCandidates() {
    const out = [];

    for (const dialog of getVisibleDialogsRanked()) {
      for (const button of Array.from(dialog.querySelectorAll("button"))) {
        if (!isPossibleFinalConfirmButton(button, dialog)) continue;

        out.push({
          button,
          dialog,
          score: scoreFinalConfirmButton(button, dialog),
          destructive: hasDestructiveVisualStyle(button),
        });
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }

  function findFinalConfirmButton() {
    const scored = getScoredFinalConfirmButtonCandidates();

    if (!scored.length) return null;

    const destructive = scored.find((item) => item.destructive);

    return destructive ? destructive.button : scored[0].button;
  }

  async function waitForFinalConfirmButton(runId, timeoutMs = CONFIRM_BUTTON_DISCOVERY_TIMEOUT_MS) {
    const started = performance.now();
    let lastCandidate = null;

    while (performance.now() - started < timeoutMs) {
      if (!autoScrolling || runId !== autoScrollRunId) return null;

      const candidate = findFinalConfirmButton();

      if (candidate) {
        lastCandidate = candidate;
        revealButtonPath(candidate, 6);

        if (hasUsableHitRect(candidate) || isVisible(candidate)) return candidate;
      }

      await wait(50);
    }

    if (lastCandidate) revealButtonPath(lastCandidate, 6);

    return lastCandidate;
  }

  async function waitForFinalConfirmClickEffect(button, dialogBefore, timeoutMs = AFTER_CONFIRM_CLICK_PAUSE_MS) {
    const started = performance.now();

    while (performance.now() - started < timeoutMs) {
      if (!button || !button.isConnected) {
        return {
          changed: true,
          reason: "final confirmation button detached after click",
        };
      }

      if (!isVisible(button)) {
        return {
          changed: true,
          reason: "final confirmation button became hidden after click",
        };
      }

      if (dialogBefore && (!dialogBefore.isConnected || !isVisible(dialogBefore))) {
        return {
          changed: true,
          reason: "confirmation dialog detached or became hidden after click",
        };
      }

      await wait(80);
    }

    return {
      changed: false,
      reason: "no simple dialog-close effect detected",
      buttonStillConnected: !!button?.isConnected,
      dialogStillVisible: !!dialogBefore && dialogBefore.isConnected && isVisible(dialogBefore),
    };
  }

  async function clickFinalConfirmButtonWithNativeClick(row, button, runId, resumeTarget) {
    if (!button || !button.isConnected) return false;
    if (!autoScrolling || runId !== autoScrollRunId) return false;

    const dialog = button.closest('[role="dialog"], [aria-modal="true"]');

    revealButtonPath(button, 6);
    focusElementNoScroll(button);

    try {
      button.click();
    } catch (error) {
      logWarn("final confirmation button.click() threw", describeElement(button), error);
      return false;
    }

    const effect = await waitForFinalConfirmClickEffect(button, dialog);

    window.__igDmUnsenderLastFinalConfirmButton = button;
    window.__igDmUnsenderLastFinalConfirmEffect = effect;

    if (resumeTarget) {
      queueResumeTarget(resumeTarget);
      await restoreResumeTargetPosition(resumeTarget, runId);
    }

    return true;
  }

  async function clickUnsendButtonWithNativeClick(row, button, runId, resumeTarget) {
    if (!row || !row.isConnected) return false;
    if (!button || !button.isConnected) return false;
    if (!autoScrolling || runId !== autoScrollRunId) return false;

    revealButtonPath(button);
    focusElementNoScroll(button);

    try {
      button.click();
    } catch (error) {
      logWarn("menu Unsend button.click() threw", describeElement(button), error);
      return false;
    }

    window.__igDmUnsenderLastUnsendButton = button;

    const waited = await waitWhileActive(CONFIRM_AFTER_UNSEND_MENU_CLICK_WAIT_MS, runId);

    if (!waited) return false;

    const confirmButton = await waitForFinalConfirmButton(runId);

    if (!autoScrolling || runId !== autoScrollRunId) return false;

    if (!confirmButton || !confirmButton.isConnected) {
      logWarn("Could not find final confirmation button after menu Unsend", {
        row: describeRow(row),
        dialogSnapshot: getDialogSnapshot(),
      });

      return true;
    }

    await clickFinalConfirmButtonWithNativeClick(row, confirmButton, runId, resumeTarget);

    return true;
  }

  async function clickMoreButtonWithNativeClick(row, button, runId, resumeTarget) {
    if (!row || !row.isConnected) return false;
    if (!button || !button.isConnected) return false;
    if (!autoScrolling || runId !== autoScrollRunId) return false;

    hoverRow(row);
    pulseActiveRow();
    revealMoreButtonPath(button, row);
    focusElementNoScroll(button);

    const beforeSnapshot = getMenuSnapshot();

    try {
      button.click();
    } catch (error) {
      logWarn("more button.click() threw", describeElement(button), error);
      return false;
    }

    const openState = await waitForMenuOpenAfterNativeClick(button, beforeSnapshot);

    if (!openState.open) {
      logWarn("more button.click() returned but menu-open verification failed", {
        openState,
        button: describeElement(button),
      });

      return false;
    }

    window.__igDmUnsenderLastSuccessfulMoreMethod = "native button.click()";
    window.__igDmUnsenderLastMoreButton = button;
    window.__igDmUnsenderLastMoreRow = row;

    stopActivePulse();

    const waitedForUnsend = await waitWhileActive(UNSEND_AFTER_MENU_OPEN_WAIT_MS, runId);

    if (!waitedForUnsend) return false;

    const unsendButton = await waitForUnsendButton(runId);

    if (!autoScrolling || runId !== autoScrollRunId) return false;

    if (!unsendButton || !unsendButton.isConnected) {
      logWarn("Could not find structural Unsend menu item after more menu opened", {
        row: describeRow(row),
        moreButton: describeElement(button),
      });

      return true;
    }

    await clickUnsendButtonWithNativeClick(row, unsendButton, runId, resumeTarget);

    return true;
  }

  async function hoverMineRowThenClickMore(row, runId, resumeTarget) {
    if (!row || !row.isConnected) return true;
    if (getRowType(row) !== "mine") return true;
    if (isSystemRow(row)) return true;

    logInfo("Processing outgoing message", {
      row: describeRow(row),
      resumeTarget: resumeTarget ? { rowId: resumeTarget.rowId, type: resumeTarget.type } : null,
    });

    hoverRow(row);
    pulseActiveRow();

    const waited = await waitWhileActive(HOVER_BEFORE_MORE_CLICK_MS, runId);

    if (!waited) return false;
    if (!row.isConnected) return true;

    pulseActiveRow();

    const moreButton = await waitForMoreButton(row, runId);

    if (!autoScrolling || runId !== autoScrollRunId) return false;

    if (!moreButton || !moreButton.isConnected) {
      logWarn("Could not find structural three-dots more-menu button for row", describeRow(row));
      return true;
    }

    setCurrentTarget(row, getRowType(row));
    requestRender();

    await clickMoreButtonWithNativeClick(row, moreButton, runId, resumeTarget);

    if (!autoScrolling || runId !== autoScrollRunId) return false;

    return waitWhileActive(AFTER_MORE_CLICK_PAUSE_MS, runId);
  }

  function activateMineRow(row) {
    if (!row || !row.isConnected) return false;
    if (getRowType(row) !== "mine" || isSystemRow(row)) return false;

    clearSyntheticActivation();

    activeRow = row;
    focusRow(row);

    for (const el of findControlCandidates(row)) {
      if (isHiddenish(el)) revealNode(el);
    }

    focusBestInnerControl(row);
    startActivePulse();

    return true;
  }

  function pulseActiveRow() {
    if (!activeRow || !activeRow.isConnected) return;

    focusRow(activeRow);

    for (const el of findControlCandidates(activeRow)) {
      if (isHiddenish(el)) revealNode(el);
    }

    focusBestInnerControl(activeRow);
  }

  function startActivePulse() {
    stopActivePulse();
    activePulseTimer = window.setInterval(() => pulseActiveRow(), ACTIVE_PULSE_MS);
  }

  function stopActivePulse() {
    if (activePulseTimer) {
      clearInterval(activePulseTimer);
      activePulseTimer = 0;
    }
  }

  function clearSyntheticActivation() {
    stopActivePulse();
    clearFocusedRows();
    removeLegacyVisualLayer();
    restoreRevealedNodes();
    activeRow = null;
  }

  async function pauseOnMineRowIfNeeded(row, runId) {
    if (!row || !row.isConnected) return true;
    if (isSystemRow(row)) return true;

    const type = getRowType(row);

    if (type !== "mine") return true;

    const key = getRowIdentityKey(row) || getRowSignature(row);

    if (!key || key === lastPausedMineKey) return true;

    const resumeTarget = snapshotPreviousRowForResume(row);

    setCurrentTarget(row, type);
    requestRender();
    activateMineRow(row);

    lastPausedMineKey = key;

    const clickedOk = await hoverMineRowThenClickMore(row, runId, resumeTarget);

    if (!clickedOk) return false;

    return waitWhileActive(MINE_PAUSE_MS, runId);
  }

  async function waitForScrollIdle(scroller) {
    const start = performance.now();
    let lastTop = getScrollerScrollTop(scroller);
    let lastChange = performance.now();

    while (performance.now() - start < SCROLL_IDLE_TIMEOUT_MS) {
      await wait(40);

      const currentTop = getScrollerScrollTop(scroller);

      if (Math.abs(currentTop - lastTop) > 1) {
        lastTop = currentTop;
        lastChange = performance.now();
        requestRender();
        continue;
      }

      if (performance.now() - lastChange >= SCROLL_IDLE_STABLE_MS) return;
    }
  }

  function scrollRowIntoFocus(row) {
    if (!row || !row.isConnected) return;

    setCurrentTarget(row, getRowType(row));
    requestRender();

    row.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }

  async function scrollChunkUpAndSettle(scroller) {
    const before = getScrollerScrollTop(scroller);
    const viewportHeight = getScrollerClientHeight(scroller);
    const amount = Math.max(SCROLL_CHUNK_MIN_PX, viewportHeight * SCROLL_CHUNK_RATIO);

    scrollScrollerBy(scroller, -amount, "smooth");
    await waitForScrollIdle(scroller);

    const after = getScrollerScrollTop(scroller);

    return Math.abs(after - before) > 2;
  }

  function stopAutoScroll({ clearIndicator = false } = {}) {
    autoScrolling = false;
    autoScrollRunId += 1;
    lastPausedMineKey = "";
    pendingResumeTarget = null;

    setInteractionBlocked(false);

    if (clearIndicator) {
      clearCurrentTarget();
      clearSyntheticActivation();
    }

    ensureControl();
    requestRender();
  }

  async function startScrollToPreviousMine() {
    if (!isDmThreadPage()) return;

    if (autoScrolling) {
      stopAutoScroll({ clearIndicator: true });
      return;
    }

    clearSyntheticActivation();
    clearPendingResumeTarget();
    lastPausedMineKey = "";

    autoScrolling = true;

    ensureControl();
    setInteractionBlocked(true);

    const runId = ++autoScrollRunId;

    logInfo("Started unsender", {
      href: location.href,
      runId,
    });

    try {
      for (let step = 0; step < 500; step++) {
        if (runId !== autoScrollRunId || !autoScrolling) return;

        requestRender();
        await wait(50);

        const list = resolveMessagesList();
        const scroller = resolveScrollContainer(list);
        const rows = getRowsInDomOrder(list);
        const chatStartVisible = isChatStartProfileCardVisible(list, scroller);

        if (!rows.length) break;

        const handledResume = await handlePendingResumeTarget(list, scroller, rows, runId);

        if (handledResume) continue;

        const viewportRect = getViewportRectForScroller(scroller);
        const hadLockedTarget = hasLockedCurrentTarget(rows, viewportRect);
        const stepBaseRow = getStepBaseRow(rows, viewportRect);

        if (stepBaseRow) {
          const baseType = getRowType(stepBaseRow);

          setCurrentTarget(stepBaseRow, baseType);
          requestRender();

          if (!hadLockedTarget) {
            const ok = await pauseOnMineRowIfNeeded(stepBaseRow, runId);

            if (!ok) return;
          }
        }

        const previousRow = stepBaseRow ? getPreviousRowByDomOrder(rows, stepBaseRow, list) : null;

        if (previousRow) {
          const chatStartCard = findChatStartProfileCard(list);

          if (isInsideChatStartProfileCard(previousRow, chatStartCard)) break;

          const targetSnapshot = snapshotRow(previousRow);

          setCurrentTarget(previousRow, targetSnapshot?.type || getRowType(previousRow));
          requestRender();

          scrollRowIntoFocus(previousRow);
          await waitForScrollIdle(scroller);
          await wait(60);
          requestRender();

          const freshList = resolveMessagesList();
          const freshRows = getRowsInDomOrder(freshList);
          const resolvedTarget =
            resolveRowSnapshot(freshRows, targetSnapshot) ||
            (previousRow.isConnected ? previousRow : null);

          if (resolvedTarget) {
            setCurrentTarget(resolvedTarget, getRowType(resolvedTarget));
          } else if (targetSnapshot) {
            setCurrentTargetIdentity({
              rowId: targetSnapshot.rowId,
              signature: targetSnapshot.signature,
              type: targetSnapshot.type,
              viewportTop: targetSnapshot.viewportTop,
              viewportCenter: targetSnapshot.viewportCenter,
            });
          }

          requestRender();

          const ok = await pauseOnMineRowIfNeeded(resolvedTarget || previousRow, runId);

          if (!ok) return;

          continue;
        }

        if (chatStartVisible) break;

        const moved = await scrollChunkUpAndSettle(scroller);

        if (!moved) break;

        const newList = resolveMessagesList();
        const newRows = getRowsInDomOrder(newList);
        const newScroller = resolveScrollContainer(newList);
        const newViewport = getViewportRectForScroller(newScroller);

        let resolvedAfterChunk =
          findRowById(newRows, currentTargetRowId) ||
          (currentTargetRow && currentTargetRow.isConnected ? currentTargetRow : null);

        if (!resolvedAfterChunk && currentTargetSignature) {
          resolvedAfterChunk = findBestRowBySignature(
            newRows,
            currentTargetSignature,
            currentTargetViewportTop,
            currentTargetViewportCenter
          );
        }

        if (!resolvedAfterChunk) resolvedAfterChunk = getNewestVisibleRow(newRows, newViewport);

        if (resolvedAfterChunk) {
          setCurrentTarget(resolvedAfterChunk, getRowType(resolvedAfterChunk));
          requestRender();

          const ok = await pauseOnMineRowIfNeeded(resolvedAfterChunk, runId);

          if (!ok) return;
        }
      }
    } finally {
      autoScrolling = false;
      pendingResumeTarget = null;
      setInteractionBlocked(false);
      ensureControl();
      requestRender();

      logInfo("Unsender finished/stopped", {
        runId,
      });
    }
  }

  function isTypingTarget(el) {
    if (!el) return false;

    const tag = el.tagName;

    return el.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function onKeyDown(event) {
    if (!isDmThreadPage()) return;
    if (isTypingTarget(event.target)) return;

    if (event.key === "Escape" && autoScrolling) {
      event.preventDefault();
      stopAutoScroll({ clearIndicator: true });
    }
  }

  function startObservers() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver(() => requestRender());

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    window.addEventListener("scroll", requestRender, true);
    window.addEventListener("resize", requestRender, true);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function monitorRoute() {
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        stopAutoScroll({ clearIndicator: true });
        requestRender();
      }
    }, ROUTE_POLL_MS);
  }

  window.__igDmUnsenderDebug = {
    get currentRow() {
      return currentTargetRow;
    },
    get currentRowDescription() {
      return describeRow(currentTargetRow);
    },
    get pendingResumeTarget() {
      return pendingResumeTarget;
    },
    get interactionBlocked() {
      return interactionBlocked;
    },
    get lastMoreButton() {
      return window.__igDmUnsenderLastMoreButton || null;
    },
    get lastSuccessfulMoreMethod() {
      return window.__igDmUnsenderLastSuccessfulMoreMethod || null;
    },
    get lastUnsendButton() {
      return window.__igDmUnsenderLastUnsendButton || null;
    },
    get lastFinalConfirmButton() {
      return window.__igDmUnsenderLastFinalConfirmButton || null;
    },
    get lastFinalConfirmEffect() {
      return window.__igDmUnsenderLastFinalConfirmEffect || null;
    },
    describeElement,
    describeRow,
    getMenuSnapshot,
    getDialogSnapshot,
    getMenuOpenState,
    findHeaderActionContainer,
    findMoreButtonForCurrentRow() {
      if (!currentTargetRow) return null;

      const scored = getScoredMoreButtonCandidatesForRow(currentTargetRow);

      return scored.length ? scored[0].button : null;
    },
    findUnsendButton,
    getScoredUnsendButtonCandidates,
    findFinalConfirmButton,
    getScoredFinalConfirmButtonCandidates,
  };

  startObservers();
  monitorRoute();
  requestRender();

  logInfo("Instagram DM unsender active. The page is blocked with a non-interactable overlay while running; Stop unsender and Escape remain usable.");
})();
