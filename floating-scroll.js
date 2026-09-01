"use strict";

const FLOATING_SCROLL_DEFAULT_SETTINGS = {
  floatingScrollSettings: {
    enabled: true,
    buttonSize: 48,
    downSpeed: 2.5,
    fastDownSpeed: 25,
    position: { x: 1, y: 0.5 }
  },
  floatingScrollDisabledSites: ["fav.ju.mp", "kio.ac", "pan.baidu.com", "kmcert.com"]
};

const FLOATING_SCROLL_MIN_SIZE = 20;
const FLOATING_SCROLL_MAX_SIZE = 140;
const FLOATING_SCROLL_MIN_SPEED = 0.25;
const FLOATING_SCROLL_MAX_SPEED = 80;

let scrollSettings = null;
let container = null;
let scrollFrame = 0;
let scrollSpeed = 0;
let scrollAccumulator = 0;
let scrollTarget = null;
let lastScrollableElement = null;
let lastFrameTime = 0;
let isPositionEditing = false;
let dragState = null;

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

function normalizeScrollSettings(value) {
  const defaultPosition = FLOATING_SCROLL_DEFAULT_SETTINGS.floatingScrollSettings.position;
  return {
    enabled: !value || value.enabled !== false,
    buttonSize: clampNumber(
      value && value.buttonSize,
      FLOATING_SCROLL_MIN_SIZE,
      FLOATING_SCROLL_MAX_SIZE,
      FLOATING_SCROLL_DEFAULT_SETTINGS.floatingScrollSettings.buttonSize
    ),
    downSpeed: clampNumber(
      value && value.downSpeed,
      FLOATING_SCROLL_MIN_SPEED,
      FLOATING_SCROLL_MAX_SPEED,
      FLOATING_SCROLL_DEFAULT_SETTINGS.floatingScrollSettings.downSpeed
    ),
    fastDownSpeed: clampNumber(
      value && value.fastDownSpeed,
      FLOATING_SCROLL_MIN_SPEED,
      FLOATING_SCROLL_MAX_SPEED,
      FLOATING_SCROLL_DEFAULT_SETTINGS.floatingScrollSettings.fastDownSpeed
    ),
    position: {
      x: clampNumber(value && value.position && value.position.x, 0, 1, defaultPosition.x),
      y: clampNumber(value && value.position && value.position.y, 0, 1, defaultPosition.y)
    }
  };
}

function normalizeDisabledSites(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(new Set(values.map(normalizeHost).filter(Boolean)));
}

function matchesHost(currentHost, host) {
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
  const scrollHeight = Math.max(
    scrollElement ? scrollElement.scrollHeight : 0,
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
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

function findBestScrollableElement(speed, excludedElement = null) {
  let bestElement = null;
  let bestScore = 0;

  for (const element of document.querySelectorAll("body *")) {
    if (element === excludedElement || !isScrollableElement(element, speed)) {
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

function findScrollableElementTarget(speed, excludedElement = null) {
  if (lastScrollableElement !== excludedElement && isScrollableElement(lastScrollableElement, speed)) {
    return { element: lastScrollableElement };
  }

  const activeScrollableElement = findClosestScrollableElement(document.activeElement, speed);
  if (activeScrollableElement && activeScrollableElement !== excludedElement) {
    return { element: activeScrollableElement };
  }

  const bestScrollableElement = findBestScrollableElement(speed, excludedElement);
  return bestScrollableElement ? { element: bestScrollableElement } : null;
}

function findScrollTarget(speed) {
  const documentTarget = { element: null };
  if (canScrollTarget(documentTarget, speed)) {
    return documentTarget;
  }

  return findScrollableElementTarget(speed) || documentTarget;
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
  const nextScrollTop = clampNumber(beforeScrollTop + scrollAmount, 0, getMaxScrollTop(), beforeScrollTop);
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

    const alternativeTarget = findScrollableElementTarget(scrollSpeed, scrollTarget.element);
    if (alternativeTarget && scrollElementByAmount(alternativeTarget.element, scrollAmount)) {
      scrollTarget = alternativeTarget;
      return true;
    }

    scrollTarget = { element: null };
    return scrollDocumentByAmount(scrollAmount);
  }

  if (scrollDocumentByAmount(scrollAmount)) {
    return true;
  }

  const alternativeTarget = findScrollableElementTarget(scrollSpeed);
  if (alternativeTarget && scrollElementByAmount(alternativeTarget.element, scrollAmount)) {
    scrollTarget = alternativeTarget;
    return true;
  }

  return false;
}

function stopAutoScroll() {
  if (scrollFrame) {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  scrollSpeed = 0;
  scrollAccumulator = 0;
  scrollTarget = null;
  lastFrameTime = 0;
}

function startAutoScroll(speed) {
  stopAutoScroll();
  scrollSpeed = clampNumber(speed, FLOATING_SCROLL_MIN_SPEED, FLOATING_SCROLL_MAX_SPEED, 0);
  if (!scrollSpeed) {
    return;
  }

  scrollTarget = findScrollTarget(scrollSpeed);

  const tick = (timestamp) => {
    if (!scrollSpeed || isAtScrollLimit(scrollSpeed)) {
      stopAutoScroll();
      return;
    }

    const elapsed = lastFrameTime ? Math.min(100, timestamp - lastFrameTime) : 1000 / 60;
    lastFrameTime = timestamp;
    scrollAccumulator += scrollSpeed * (elapsed / (1000 / 60));
    const scrollAmount = Math.floor(scrollAccumulator);

    if (scrollAmount > 0) {
      scrollAccumulator -= scrollAmount;
      if (!scrollByAmount(scrollAmount)) {
        stopAutoScroll();
        return;
      }
    }

    scrollFrame = window.requestAnimationFrame(tick);
  };

  scrollFrame = window.requestAnimationFrame(tick);
}

function scrollPageTo(top) {
  stopAutoScroll();
  const targetTop = Math.round(clampNumber(top, 0, getMaxScrollTop(), 0));

  try {
    window.scrollTo({ top: targetTop, behavior: "smooth" });
  } catch {
    window.scrollTo(0, targetTop);
  }
}

function getContainerBounds() {
  if (!container) {
    return null;
  }

  const rect = container.getBoundingClientRect();
  const gap = 12;
  const maxLeft = Math.max(gap, window.innerWidth - rect.width - gap);
  const maxTop = Math.max(gap, window.innerHeight - rect.height - gap);
  return {
    gap,
    maxLeft,
    maxTop,
    rangeX: Math.max(0, maxLeft - gap),
    rangeY: Math.max(0, maxTop - gap)
  };
}

function positionContainer() {
  if (!container || !scrollSettings) {
    return;
  }

  const bounds = getContainerBounds();
  if (!bounds) {
    return;
  }

  const position = scrollSettings.position;
  const left = bounds.gap + bounds.rangeX * position.x;
  const top = bounds.gap + bounds.rangeY * position.y;
  container.style.left = Math.round(left) + "px";
  container.style.top = Math.round(top) + "px";
}

function persistPosition() {
  if (!scrollSettings) {
    return;
  }

  chrome.storage.sync.set({ floatingScrollSettings: scrollSettings }, () => {
    // Ignore transient page-unload and extension-reload errors.
    void chrome.runtime.lastError;
  });
}

function setPositionEditing(enabled) {
  isPositionEditing = Boolean(enabled && container && scrollSettings);
  if (!container) {
    return false;
  }

  const finishButton = container.querySelector("[data-nyankat-position-finish]");
  container.style.cursor = isPositionEditing ? "move" : "";
  container.style.outline = isPositionEditing ? "2px solid #60a5fa" : "";
  container.style.outlineOffset = isPositionEditing ? "4px" : "";
  container.title = isPositionEditing ? "드래그해서 위치를 조정하세요." : "";

  if (isPositionEditing && !finishButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "완료";
    button.title = "위치 조정 완료";
    button.setAttribute("data-nyankat-position-finish", "true");
    button.style.cssText = [
      "background:#2563eb",
      "border:1px solid rgba(255,255,255,.55)",
      "border-radius:6px",
      "bottom:calc(100% + 8px)",
      "color:white",
      "cursor:pointer",
      "font:600 12px system-ui,sans-serif",
      "padding:5px 8px",
      "position:absolute",
      "right:0"
    ].join(";");
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setPositionEditing(false);
    });
    container.append(button);
  } else if (!isPositionEditing && finishButton) {
    finishButton.remove();
  }

  return isPositionEditing;
}

function beginPositionDrag(event) {
  if (!isPositionEditing || !container || event.button !== 0) {
    return;
  }

  const rect = container.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };
  event.preventDefault();
  container.setPointerCapture(event.pointerId);
}

function movePositionDrag(event) {
  if (!dragState || !container || event.pointerId !== dragState.pointerId || !scrollSettings) {
    return;
  }

  const bounds = getContainerBounds();
  if (!bounds) {
    return;
  }

  const left = clampNumber(event.clientX - dragState.offsetX, bounds.gap, bounds.maxLeft, bounds.gap);
  const top = clampNumber(event.clientY - dragState.offsetY, bounds.gap, bounds.maxTop, bounds.gap);
  scrollSettings.position = {
    x: bounds.rangeX ? (left - bounds.gap) / bounds.rangeX : 0,
    y: bounds.rangeY ? (top - bounds.gap) / bounds.rangeY : 0
  };
  positionContainer();
  event.preventDefault();
}

function endPositionDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  if (container && container.hasPointerCapture(event.pointerId)) {
    container.releasePointerCapture(event.pointerId);
  }
  dragState = null;
  persistPosition();
}

function createButton(label, title, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
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
    "font-size:" + Math.max(14, Math.round(scrollSettings.buttonSize * 0.58)) + "px",
    "height:" + scrollSettings.buttonSize + "px",
    "justify-content:center",
    "line-height:1",
    "padding:0",
    "touch-action:none",
    "width:" + scrollSettings.buttonSize + "px"
  ].join(";");

  button.addEventListener("pointerdown", (event) => {
    if (isPositionEditing) {
      return;
    }
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isPositionEditing) {
      return;
    }
    action();
  });

  return button;
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
}

function renderContainer() {
  if (!scrollSettings || !document.documentElement) {
    removeContainer();
    return;
  }

  removeContainer();
  const size = scrollSettings.buttonSize;
  const wasPositionEditing = isPositionEditing;
  container = document.createElement("div");
  container.setAttribute("data-nyankat-floating-scroll", "true");
  container.setAttribute("aria-label", "자동 스크롤 버튼");
  container.style.cssText = [
    "display:grid",
    "gap:6px",
    "grid-template-columns:repeat(2, " + size + "px)",
    "grid-template-rows:repeat(2, " + size + "px)",
    "position:fixed",
    "z-index:2147483647",
    "user-select:none",
    "touch-action:none"
  ].join(";");

  container.append(
    createButton("🔽", "아래로 자동 스크롤", () => startAutoScroll(scrollSettings.downSpeed)),
    createButton("⬆️", "페이지 최상단으로 이동", () => scrollPageTo(0)),
    createButton("⏬", "빠르게 아래로 자동 스크롤", () => startAutoScroll(scrollSettings.fastDownSpeed)),
    createButton("⬇️", "페이지 90% 지점으로 이동", () => scrollPageTo(getMaxScrollTop() * 0.9))
  );
  container.addEventListener("pointerdown", beginPositionDrag);
  container.addEventListener("pointermove", movePositionDrag);
  container.addEventListener("pointerup", endPositionDrag);
  container.addEventListener("pointercancel", endPositionDrag);

  document.documentElement.append(container);
  positionContainer();
  setPositionEditing(wasPositionEditing);
}

function applySettings(settings) {
  const currentHost = location.hostname.toLowerCase();
  const disabledSites = normalizeDisabledSites(settings.floatingScrollDisabledSites);
  if (disabledSites.some((host) => matchesHost(currentHost, host))) {
    scrollSettings = null;
    isPositionEditing = false;
    renderContainer();
    return;
  }

  const normalizedSettings = normalizeScrollSettings(settings.floatingScrollSettings);
  scrollSettings = normalizedSettings.enabled ? normalizedSettings : null;
  if (!scrollSettings) {
    isPositionEditing = false;
  }
  renderContainer();
}

function init() {
  chrome.storage.sync.get(FLOATING_SCROLL_DEFAULT_SETTINGS, applySettings);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "sync" ||
    (!changes.floatingScrollSettings && !changes.floatingScrollDisabledSites)
  ) {
    return;
  }

  chrome.storage.sync.get(FLOATING_SCROLL_DEFAULT_SETTINGS, applySettings);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "NYANKAT_FLOATING_SCROLL_SET_POSITION_MODE") {
    return;
  }

  const enabled = setPositionEditing(message.enabled === true);
  sendResponse({
    ok: enabled || message.enabled !== true,
    enabled,
    reason: enabled || message.enabled !== true ? undefined : "button_not_available"
  });
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
window.addEventListener("resize", positionContainer);
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
