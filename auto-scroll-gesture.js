"use strict";

const AUTO_SCROLL_DEFAULT_SETTINGS = {
  mouseGestureAutoScrollMode: "down",
  autoScrollSpeed: 2
};

const AUTO_SCROLL_MODES = new Set(["off", "down", "both"]);
const AUTO_SCROLL_MIN_SPEED = 0.25;
const AUTO_SCROLL_MAX_SPEED = 6;
const AUTO_SCROLL_SPEED_STEP = 0.25;
const GESTURE_MIN_VERTICAL_DISTANCE = 72;
const GESTURE_VERTICAL_RATIO = 1.5;
const RIGHT_MOUSE_BUTTON = 2;

let mouseGestureAutoScrollMode = AUTO_SCROLL_DEFAULT_SETTINGS.mouseGestureAutoScrollMode;
let autoScrollSpeed = AUTO_SCROLL_DEFAULT_SETTINGS.autoScrollSpeed;
let pendingGesture = null;
let suppressNextContextMenu = false;
let scrollFrame = 0;
let scrollDirection = 0;
let scrollAccumulator = 0;

function normalizeAutoScrollMode(value) {
  return AUTO_SCROLL_MODES.has(value) ? value : AUTO_SCROLL_DEFAULT_SETTINGS.mouseGestureAutoScrollMode;
}

function normalizeAutoScrollSpeed(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return AUTO_SCROLL_DEFAULT_SETTINGS.autoScrollSpeed;
  }

  const steppedValue = Math.round(numericValue / AUTO_SCROLL_SPEED_STEP) * AUTO_SCROLL_SPEED_STEP;
  const clampedValue = Math.min(AUTO_SCROLL_MAX_SPEED, Math.max(AUTO_SCROLL_MIN_SPEED, steppedValue));
  return Number(clampedValue.toFixed(2));
}

function applyAutoScrollSettings(settings) {
  mouseGestureAutoScrollMode = normalizeAutoScrollMode(settings.mouseGestureAutoScrollMode);
  autoScrollSpeed = normalizeAutoScrollSpeed(settings.autoScrollSpeed);

  if (
    mouseGestureAutoScrollMode === "off" ||
    (mouseGestureAutoScrollMode === "down" && scrollDirection < 0)
  ) {
    stopAutoScroll();
  }
}

function isEditableTarget(target) {
  const element = target instanceof Element ? target : target && target.parentElement;
  return Boolean(
    element &&
      element.closest(
        "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"
      )
  );
}

function getGestureDirection(startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);

  if (absoluteY < GESTURE_MIN_VERTICAL_DISTANCE || absoluteY < absoluteX * GESTURE_VERTICAL_RATIO) {
    return 0;
  }

  return deltaY > 0 ? 1 : -1;
}

function isDirectionAllowed(direction) {
  return direction > 0
    ? mouseGestureAutoScrollMode === "down" || mouseGestureAutoScrollMode === "both"
    : mouseGestureAutoScrollMode === "both";
}

function getScrollElement() {
  return document.scrollingElement || document.documentElement;
}

function getScrollTop() {
  const scrollElement = getScrollElement();
  return scrollElement ? scrollElement.scrollTop : window.scrollY;
}

function getMaxScrollTop() {
  const scrollElement = getScrollElement();
  if (!scrollElement) {
    return 0;
  }

  return Math.max(0, scrollElement.scrollHeight - window.innerHeight);
}

function isAtScrollLimit(direction) {
  const scrollTop = getScrollTop();
  return direction > 0 ? scrollTop >= getMaxScrollTop() - 1 : scrollTop <= 0;
}

function stopAutoScroll() {
  if (scrollFrame) {
    window.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  scrollDirection = 0;
  scrollAccumulator = 0;
}

function startAutoScroll(direction) {
  stopAutoScroll();
  scrollDirection = direction;

  const tick = () => {
    if (!scrollDirection || isAtScrollLimit(scrollDirection)) {
      stopAutoScroll();
      return;
    }

    scrollAccumulator += scrollDirection * autoScrollSpeed;
    const scrollAmount =
      scrollAccumulator > 0 ? Math.floor(scrollAccumulator) : Math.ceil(scrollAccumulator);

    if (scrollAmount === 0) {
      scrollFrame = window.requestAnimationFrame(tick);
      return;
    }

    scrollAccumulator -= scrollAmount;

    const beforeScrollTop = getScrollTop();
    window.scrollBy(0, scrollAmount);
    if (getScrollTop() === beforeScrollTop) {
      stopAutoScroll();
      return;
    }

    scrollFrame = window.requestAnimationFrame(tick);
  };

  scrollFrame = window.requestAnimationFrame(tick);
}

function handleMouseDown(event) {
  if (scrollDirection) {
    stopAutoScroll();
    return;
  }

  if (
    event.button !== RIGHT_MOUSE_BUTTON ||
    mouseGestureAutoScrollMode === "off" ||
    isEditableTarget(event.target)
  ) {
    pendingGesture = null;
    return;
  }

  pendingGesture = {
    startX: event.clientX,
    startY: event.clientY
  };
}

function handleMouseMove(event) {
  if (!pendingGesture) {
    return;
  }

  if ((event.buttons & 2) !== 2) {
    pendingGesture = null;
    return;
  }

  const direction = getGestureDirection(
    pendingGesture.startX,
    pendingGesture.startY,
    event.clientX,
    event.clientY
  );

  if (!direction || !isDirectionAllowed(direction)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
}

function handleMouseUp(event) {
  if (event.button !== RIGHT_MOUSE_BUTTON || !pendingGesture) {
    return;
  }

  const direction = getGestureDirection(
    pendingGesture.startX,
    pendingGesture.startY,
    event.clientX,
    event.clientY
  );
  const shouldStart = direction && isDirectionAllowed(direction);

  pendingGesture = null;

  if (!shouldStart) {
    return;
  }

  suppressNextContextMenu = true;
  window.setTimeout(() => {
    suppressNextContextMenu = false;
  }, 500);

  event.preventDefault();
  event.stopImmediatePropagation();
  startAutoScroll(direction);
}

function handleContextMenu(event) {
  if (!suppressNextContextMenu) {
    return;
  }

  suppressNextContextMenu = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}

chrome.storage.sync.get(AUTO_SCROLL_DEFAULT_SETTINGS, applyAutoScrollSettings);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }

  applyAutoScrollSettings({
    mouseGestureAutoScrollMode: changes.mouseGestureAutoScrollMode
      ? changes.mouseGestureAutoScrollMode.newValue
      : mouseGestureAutoScrollMode,
    autoScrollSpeed: changes.autoScrollSpeed ? changes.autoScrollSpeed.newValue : autoScrollSpeed
  });
});

window.addEventListener("mousedown", handleMouseDown, true);
window.addEventListener("mousemove", handleMouseMove, { capture: true, passive: false });
window.addEventListener("mouseup", handleMouseUp, { capture: true, passive: false });
window.addEventListener("contextmenu", handleContextMenu, { capture: true, passive: false });
window.addEventListener("keydown", stopAutoScroll, true);
window.addEventListener("blur", stopAutoScroll, true);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopAutoScroll();
  }
});
