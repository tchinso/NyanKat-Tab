"use strict";

const FLOATING_SCROLL_DEFAULT_SETTINGS = {
  floatingScrollSites: [
    { host: "dcinside.com", upSpeed: 40, downSpeed: 1.5, fastDownSpeed: 25, buttonSize: 64, position: null },
    { host: "kone.gg", upSpeed: 40, downSpeed: 2, fastDownSpeed: 10, buttonSize: 100, position: null }
  ]
};

const FLOATING_SCROLL_MIN_SIZE = 20;
const FLOATING_SCROLL_MAX_SIZE = 140;
const FLOATING_SCROLL_STORAGE_KEY = "floatingScrollSites";
const FLOATING_SCROLL_CLICK_COOLDOWN_MS = 800;

let siteSetting = null;
let container = null;
let scrollFrame = 0;
let scrollSpeed = 0;
let scrollAccumulator = 0;
let scrollTarget = null;
let lastScrollableElement = null;
let dragState = null;
let suppressNextButtonClick = false;
let nextButtonScrollStartAt = 0;

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "")
    .toLowerCase();
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numberValue));
}

function normalizeSiteSetting(value) {
  const host = normalizeHost(value && value.host);
  if (!host) {
    return null;
  }

  const position = value.position && typeof value.position === "object"
    ? {
        left: clampNumber(value.position.left, 0, Math.max(0, window.innerWidth - 64), 24),
        top: clampNumber(value.position.top, 0, Math.max(0, window.innerHeight - 64), 140)
      }
    : null;

  return {
    host,
    upSpeed: clampNumber(value.upSpeed, 0.25, 80, 40),
    downSpeed: clampNumber(value.downSpeed, 0.25, 80, 2),
    fastDownSpeed: clampNumber(value.fastDownSpeed, 0.25, 80, 20),
    buttonSize: clampNumber(value.buttonSize, FLOATING_SCROLL_MIN_SIZE, FLOATING_SCROLL_MAX_SIZE, 64),
    position
  };
}

function normalizeSiteSettings(values) {
  if (!Array.isArray(values)) {
    return FLOATING_SCROLL_DEFAULT_SETTINGS.floatingScrollSites;
  }

  return values.map(normalizeSiteSetting).filter(Boolean);
}

function matchesCurrentHost(host) {
  const currentHost = location.hostname.toLowerCase();
  return currentHost === host || currentHost.endsWith("." + host);
}

function getScrollElement() {
  return document.scrollingElement || document.documentElement;
}

function getScrollTop() {
  const scrollElement = getScrollElement();
  return Math.max(
    window.scrollY || window.pageYOffset || 0,
    scrollElement ? scrollElement.scrollTop : 0,
    document.documentElement ? document.documentElement.scrollTop : 0,
    document.body ? document.body.scrollTop : 0
  );
}

function getMaxScrollTop() {
  const scrollElement = getScrollElement();
  const documentElement = document.documentElement;
  const body = document.body;
  const scrollHeight = Math.max(
    scrollElement ? scrollElement.scrollHeight : 0,
    documentElement ? documentElement.scrollHeight : 0,
    body ? body.scrollHeight : 0
  );

  return Math.max(0, scrollHeight - window.innerHeight);
}

function getElementMaxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function getScrollTargetTop(target) {
  return target && target.element ? target.element.scrollTop : getScrollTop();
}

function getScrollTargetMaxTop(target) {
  return target && target.element ? getElementMaxScrollTop(target.element) : getMaxScrollTop();
}

function canScrollTarget(target, speed) {
  const scrollTop = getScrollTargetTop(target);
  const maxScrollTop = getScrollTargetMaxTop(target);
  return speed > 0 ? scrollTop < maxScrollTop - 1 : scrollTop > 0;
}

function isScrollableElement(element, speed) {
  if (
    !(element instanceof Element) ||
    element === document.documentElement ||
    element === document.body ||
    (container && (element === container || container.contains(element))) ||
    element.isConnected === false
  ) {
    return false;
  }

  const maxScrollTop = getElementMaxScrollTop(element);
  if (maxScrollTop <= 1) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (!/(auto|scroll|overlay)/.test(style.overflowY)) {
    return false;
  }

  if (!speed) {
    return element.scrollTop > 0 || element.scrollTop < maxScrollTop - 1;
  }

  return speed > 0 ? element.scrollTop < maxScrollTop - 1 : element.scrollTop > 0;
}

function findClosestScrollableElement(target, speed) {
  let element = target instanceof Element ? target : target && target.parentElement;

  while (element && element !== document.documentElement) {
    if (isScrollableElement(element, speed)) {
      return element;
    }

    element = element.parentElement;
  }

  return null;
}

function findBestScrollableElement(speed) {
  let bestElement = null;
  let bestScore = 0;

  for (const element of document.querySelectorAll("body *")) {
    if (!isScrollableElement(element, speed)) {
      continue;
    }

    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left);
    const visibleHeight = Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top);
    if (visibleWidth <= 0 || visibleHeight <= 0) {
      continue;
    }

    const visibleArea = visibleWidth * visibleHeight;
    const score = visibleArea + Math.min(getElementMaxScrollTop(element), 10000) * 10;
    if (score > bestScore) {
      bestScore = score;
      bestElement = element;
    }
  }

  return bestElement;
}

function findScrollTarget(speed) {
  const documentTarget = { element: null };
  if (canScrollTarget(documentTarget, speed)) {
    return documentTarget;
  }

  if (isScrollableElement(lastScrollableElement, speed)) {
    return { element: lastScrollableElement };
  }

  const activeScrollableElement = findClosestScrollableElement(document.activeElement, speed);
  if (activeScrollableElement) {
    return { element: activeScrollableElement };
  }

  const bestScrollableElement = findBestScrollableElement(speed);
  return bestScrollableElement ? { element: bestScrollableElement } : documentTarget;
}

function isAtScrollLimit(speed) {
  if (!scrollTarget || !canScrollTarget(scrollTarget, speed)) {
    scrollTarget = findScrollTarget(speed);
  }

  return !canScrollTarget(scrollTarget, speed);
}

function scrollDocumentByAmount(scrollAmount) {
  const beforeScrollTop = getScrollTop();
  window.scrollBy(0, scrollAmount);

  if (getScrollTop() !== beforeScrollTop) {
    return true;
  }

  const scrollElements = [getScrollElement(), document.documentElement, document.body].filter(
    (element, index, elements) => element && elements.indexOf(element) === index
  );
  if (scrollElements.length === 0) {
    return false;
  }

  const nextScrollTop = clampNumber(
    beforeScrollTop + scrollAmount,
    0,
    getMaxScrollTop(),
    beforeScrollTop
  );
  if (nextScrollTop === beforeScrollTop) {
    return false;
  }

  for (const scrollElement of scrollElements) {
    scrollElement.scrollTop = nextScrollTop;
    if (getScrollTop() !== beforeScrollTop) {
      return true;
    }
  }

  return false;
}

function scrollElementByAmount(element, scrollAmount) {
  const beforeScrollTop = element.scrollTop;
  const nextScrollTop = clampNumber(
    beforeScrollTop + scrollAmount,
    0,
    getElementMaxScrollTop(element),
    beforeScrollTop
  );
  if (nextScrollTop === beforeScrollTop) {
    return false;
  }

  element.scrollTop = nextScrollTop;
  return element.scrollTop !== beforeScrollTop;
}

function scrollByAmount(scrollAmount) {
  if (!scrollTarget || !canScrollTarget(scrollTarget, scrollSpeed)) {
    scrollTarget = findScrollTarget(scrollSpeed);
  }

  if (scrollTarget && scrollTarget.element) {
    if (scrollElementByAmount(scrollTarget.element, scrollAmount)) {
      return true;
    }

    scrollTarget = findScrollTarget(scrollSpeed);
    return scrollTarget && scrollTarget.element
      ? scrollElementByAmount(scrollTarget.element, scrollAmount)
      : scrollDocumentByAmount(scrollAmount);
  }

  return scrollDocumentByAmount(scrollAmount);
}

function stopAutoScroll() {
  if (scrollFrame) {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  scrollSpeed = 0;
  scrollAccumulator = 0;
  scrollTarget = null;
}

function startAutoScroll(speed) {
  stopAutoScroll();
  scrollSpeed = speed;
  scrollTarget = findScrollTarget(speed);

  const tick = () => {
    if (!scrollSpeed || isAtScrollLimit(scrollSpeed)) {
      stopAutoScroll();
      return;
    }

    scrollAccumulator += scrollSpeed;
    const scrollAmount = scrollAccumulator > 0 ? Math.floor(scrollAccumulator) : Math.ceil(scrollAccumulator);

    if (scrollAmount === 0) {
      scrollFrame = window.requestAnimationFrame(tick);
      return;
    }

    scrollAccumulator -= scrollAmount;
    if (!scrollByAmount(scrollAmount)) {
      stopAutoScroll();
      return;
    }

    scrollFrame = window.requestAnimationFrame(tick);
  };

  scrollFrame = window.requestAnimationFrame(tick);
}

function getDefaultPosition(size) {
  return {
    left: Math.max(8, window.innerWidth - size - 24),
    top: Math.max(8, Math.round((window.innerHeight - size * 3 - 18) / 2))
  };
}

function savePosition(left, top) {
  if (!siteSetting) {
    return;
  }

  chrome.storage.sync.get(FLOATING_SCROLL_DEFAULT_SETTINGS, (settings) => {
    const sites = normalizeSiteSettings(settings.floatingScrollSites);
    const nextSites = sites.map((site) =>
      site.host === siteSetting.host ? { ...site, position: { left, top } } : site
    );
    chrome.storage.sync.set({ [FLOATING_SCROLL_STORAGE_KEY]: nextSites });
  });
}

function positionContainer(left, top) {
  if (!container || !siteSetting) {
    return;
  }

  const rect = container.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - rect.width);
  const maxTop = Math.max(0, window.innerHeight - rect.height);
  container.style.left = Math.round(clampNumber(left, 0, maxLeft, 0)) + "px";
  container.style.top = Math.round(clampNumber(top, 0, maxTop, 0)) + "px";
}

function handleButtonActivation(event, speed) {
  if (suppressNextButtonClick) {
    suppressNextButtonClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const now = Date.now();
  if (now < nextButtonScrollStartAt) {
    return;
  }

  nextButtonScrollStartAt = now + FLOATING_SCROLL_CLICK_COOLDOWN_MS;
  startAutoScroll(speed);
}

function createButton(label, title, speed) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.style.cssText = [
    "align-items:center",
    "background:rgba(20,20,20,.84)",
    "border:1px solid rgba(255,255,255,.3)",
    "border-radius:10px",
    "box-shadow:0 6px 18px rgba(0,0,0,.22)",
    "color:white",
    "cursor:pointer",
    "display:flex",
    "font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif",
    "font-size:" + Math.max(14, Math.round(siteSetting.buttonSize * 0.58)) + "px",
    "height:" + siteSetting.buttonSize + "px",
    "justify-content:center",
    "line-height:1",
    "padding:0",
    "touch-action:none",
    "width:" + siteSetting.buttonSize + "px"
  ].join(";");

  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });

  button.addEventListener("pointerup", (event) => {
    if (event.button !== 0) {
      return;
    }

    handleButtonActivation(event, speed);
  });
  button.addEventListener("click", (event) => handleButtonActivation(event, speed));

  return button;
}

function handlePointerDown(event) {
  if (
    !container ||
    event.button !== 0 ||
    (event.target instanceof Element && event.target.closest("button"))
  ) {
    return;
  }

  const rect = container.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    startX: event.clientX,
    startY: event.clientY,
    wasDragging: false
  };
  container.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  const deltaX = Math.abs(event.clientX - dragState.startX);
  const deltaY = Math.abs(event.clientY - dragState.startY);
  if (deltaX > 4 || deltaY > 4) {
    dragState.wasDragging = true;
  }

  positionContainer(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
}

function handlePointerUp(event) {
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  const currentDrag = dragState;
  dragState = null;

  if (container) {
    container.releasePointerCapture(event.pointerId);

    if (currentDrag.wasDragging) {
      const rect = container.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    }
  }

  suppressNextButtonClick = currentDrag.wasDragging;
  window.setTimeout(() => {
    suppressNextButtonClick = false;
  }, 0);
}

function rememberScrollableElement(event) {
  if (container && container.contains(event.target)) {
    return;
  }

  const scrollableElement = findClosestScrollableElement(event.target, 0);
  if (scrollableElement) {
    lastScrollableElement = scrollableElement;
  }
}

function removeContainer() {
  stopAutoScroll();
  if (container) {
    container.remove();
    container = null;
  }

  nextButtonScrollStartAt = 0;
}

function renderContainer() {
  if (!siteSetting || !document.documentElement) {
    removeContainer();
    return;
  }

  removeContainer();
  container = document.createElement("div");
  container.setAttribute("data-nyankat-floating-scroll", "true");
  container.style.cssText = [
    "display:grid",
    "gap:6px",
    "position:fixed",
    "z-index:2147483647",
    "user-select:none",
    "touch-action:none"
  ].join(";");

  container.append(
    createButton("⏫", "빠르게 위로 스크롤", -siteSetting.upSpeed),
    createButton("🔽", "아래로 스크롤", siteSetting.downSpeed),
    createButton("⏬", "빠르게 아래로 스크롤", siteSetting.fastDownSpeed)
  );

  container.addEventListener("pointerdown", handlePointerDown);
  container.addEventListener("pointermove", handlePointerMove);
  container.addEventListener("pointerup", handlePointerUp);
  container.addEventListener("pointercancel", handlePointerUp);

  document.documentElement.append(container);
  const position = siteSetting.position || getDefaultPosition(siteSetting.buttonSize);
  positionContainer(position.left, position.top);
}

function applySettings(settings) {
  const sites = normalizeSiteSettings(settings.floatingScrollSites);
  siteSetting = sites.find((site) => matchesCurrentHost(site.host)) || null;
  renderContainer();
}

function init() {
  chrome.storage.sync.get(FLOATING_SCROLL_DEFAULT_SETTINGS, applySettings);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.floatingScrollSites) {
    return;
  }

  applySettings({ floatingScrollSites: changes.floatingScrollSites.newValue });
});

window.addEventListener("mousedown", (event) => {
  if (!container || !container.contains(event.target)) {
    rememberScrollableElement(event);
    stopAutoScroll();
  }
}, true);
window.addEventListener("wheel", rememberScrollableElement, { capture: true, passive: true });
window.addEventListener("keydown", stopAutoScroll, true);
window.addEventListener("blur", stopAutoScroll, true);
window.addEventListener("resize", () => {
  if (!container) {
    return;
  }

  const rect = container.getBoundingClientRect();
  positionContainer(rect.left, rect.top);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoScroll();
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
