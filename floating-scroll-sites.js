"use strict";

// Site entries normally cover a hostname and its subdomains. YouTube entries
// additionally distinguish its watch, Shorts, channel, and general pages.
(() => {
  const YOUTUBE_HOST = "www.youtube.com";
  const YOUTUBE_SECTIONS = ["/shorts", "/watch", "/@"];

  function normalizeSite(value) {
    const input = String(value || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^\*\./, "");
    if (!input) return "";

    let url;
    try { url = new URL("https://" + input); } catch { return ""; }
    const host = url.hostname.toLowerCase();
    if (host !== YOUTUBE_HOST) return host;

    const section = YOUTUBE_SECTIONS.find((prefix) => url.pathname.startsWith(prefix));
    return host + (section || "");
  }

  function matchesSite(pageUrl, disabledSite) {
    const site = normalizeSite(disabledSite);
    if (!site) return false;

    let url;
    try { url = new URL(pageUrl); } catch { return false; }
    const host = url.hostname.toLowerCase();
    if (site === YOUTUBE_HOST || YOUTUBE_SECTIONS.some((section) => site === YOUTUBE_HOST + section)) {
      return host === YOUTUBE_HOST && normalizeSite(pageUrl) === site;
    }
    return host === site || host.endsWith("." + site);
  }

  globalThis.NyanKatScrollSites = Object.freeze({ normalizeSite, matchesSite });
})();
