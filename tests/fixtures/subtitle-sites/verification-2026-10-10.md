# Installed-extension subtitle verification

Verified on **2026-10-10 (Asia/Seoul)** for extension **1.3.3** using the ten sites from the earlier [mechanism observations](README.md).

This report distinguishes the unpacked extension's behavior in isolated desktop-browser test profiles from site playback in the Codex in-app browser (IAB). IAB observations establish player reachability; they do not verify extension extraction, downloads, or translation. Each extension PASS covers one selected English subtitle track.

The complete pipeline was confirmed on six original episode pages and on AnikotoTV's observed embedded player. The remaining three sites require further live validation in a browser that reaches their player.

## Results

PASS means the indicated operation completed. Unverified means a prerequisite prevented a complete extension check. Extraction requires a validated complete subtitle body. Download requires the browser download to complete and the saved file's size to match. Translation requires Korean text to appear in the actual video overlay; API availability or successful model creation alone is insufficient.

| Site | Extension extraction | Actual download | Korean overlay | Selected file | Cues | Bytes | Browser and scope |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| anikototv.to | PASS (player only) | PASS (player only) | PASS (player only) | VTT | 369 | 25,684 | Chrome 155 tested the exact Megaplay embed observed in IAB, with the original watch-page referrer. Outer watch-page extension integration remains unverified. |
| reanime.to | PASS | PASS | PASS | ASS | 369 | 43,421 | Chrome 155; actual flixcloud.cc player, English import, and Korean overlay. |
| www.miruro.cx | PASS | PASS | PASS | VTT | 369 | 25,684 | Chrome 155 and Edge 155; the actual strm.cx embedded player was tested. |
| anizone.to | PASS | PASS | PASS | ASS | 369 | 44,537 | Chrome 155; English import, overlay application, and Korean output. |
| kaa.lt | PASS | PASS | PASS | VTT | 366 | 25,879 | Chrome 155; actual krussdomi.com player, originating-frame download, and Korean overlay. |
| anime.nexus | Unverified | Unverified | Unverified | — | — | — | Both isolated Chrome and IAB redirected to Google before the episode player loaded. |
| ani.pm | Unverified | Unverified | Unverified | — | — | — | Supplied signed episode URL returned 404. Current SUB + SOFT playback and native English captions worked in IAB. Both Ani.pm and JW Player modes remained blocked by Settlar's security verification in isolated Chrome. |
| www.animeonsen.xyz | PASS | PASS | PASS | ASS | 369 | 43,466 | Chrome 155; site-session response, renderer subtitles, and actual Korean overlay. |
| animex.one | PASS | PASS | PASS | VTT | 369 | 25,684 | Chrome 155; actual plyr.animex.one embedded player and Korean overlay. |
| lunarx.to | Unverified | Unverified | Unverified | — | — | — | Isolated Chrome remained at Cloudflare verification; IAB's episode loader navigated to about:blank before a playable source appeared. |

## Runtime evidence

- **AnikotoTV:** IAB loaded the supplied episode's Megaplay iframe after the ordinary Play control. In isolated Chrome, the outer watch URL remained a generic landing page even after 40 seconds and rescans. Extension verification therefore used that exact observed embed through an ordinary navigation with the watch-page referrer. The player test saved the full 369-cue VTT, imported English, made eight native streaming calls, and displayed 87 characters of Korean output. This confirms the observed player pipeline; it does not confirm extension integration through the outer watch page.
- **Reanime:** the installed extension saved the full English ASS, preserved its English track metadata, imported the file with English selected, and produced Korean output through seven native streaming calls. The observed overlay contained 114 characters. The final discovery list contained eleven caption files and one cached ASS Blob; the renderer JavaScript was excluded from subtitle candidates.
- **Anizone:** the full English ASS download and import succeeded. Eight native streaming calls produced an overlay containing 87 characters of Korean output.
- **Kaa:** the full English VTT download and import succeeded through the originating player context. Two native streaming calls produced an overlay containing 23 characters of Korean output.
- **Miruro:** the English subtitle body was a full VTT despite its `.jpeg` URL. Both browsers saved all 369 cues, imported the file into **자막 파일**, selected **영어**, and applied the overlay. Chrome also prepared the same track through both its parent-page discovery and its player-frame discovery. Chrome translated an actual dialogue cue after seeking to 12.38 seconds, with two native streaming calls; Edge's real model-preparation click created the English → Korean translator and produced two streaming calls. Korean text remained visible after the popup closed. Neither browser reported runtime exceptions in these checks.
- **AnimeOnsen:** the installed extension retrieved and saved the complete English ASS from the site's ordinary session. Native creation received user activation, two streaming calls ran, and Korean output appeared in the overlay.
- **AnimeX:** the installed extension retrieved and saved the English VTT, imported it with English selected, and displayed Korean output. Translation had already completed through automatic cached-model preparation before instrumentation attached, so no per-site streaming-call count is claimed.
- **Ani.pm:** the current episode page loaded in both environments. IAB played the ordinary SUB + SOFT selection with an English native text track. In isolated Chrome, switching the ordinary **Player** control from Ani.pm to **JW Player** succeeded, but both modes' Settlar frames displayed a Cloudflare block page and exposed no video or caption candidates. Extraction, actual file saving, and native overlay translation could not be verified in that environment. The supplied older signed episode URL's 404 is a separate observation.

Chrome native checks reused officially downloaded translation components from an isolated test profile. Fresh profiles contained the translation cache only; they did not copy the user's browser profile. Edge's Miruro check exercised the actual first-use preparation button. No native Translator feature flag was forced.

## Fixes verified

- Semantic subtitle tracks are recognized even when a CDN uses an image extension or a misleading response MIME type. Timed subtitle content still determines whether a body is downloadable.
- Page-context caption reads retain site-session credentials first, then use the browser's default credential mode after a cross-origin network/CORS failure. Miruro's CDN rejects credentialed cross-origin reads but accepts the default mode.
- A discovery in a parent page can use another known player-frame discovery for the same URL and representation. This preserves the originating frame context needed by referrer-sensitive caption servers.
- Rediscovery by a generic network response preserves the player's English label, language, and descriptive metadata.
- Data-only inline JavaScript caption objects retain their English labels and language metadata without executing page expressions.
- A player that hides its native video until playback becomes an overlay target after Play. Miruro's existing open-shadow-root discovery required no relaxation of hidden-video filtering.

## Verification limits and repository checks

Security-verification pages, episode URLs returning 404, redirects, and absent player sources prevented complete installed-extension checks on the rows marked Unverified. For those rows, extension compatibility remains unverified despite any observed site captions. Security challenges were not bypassed.

The final implementation passed **170 automated tests**, syntax checks for changed runtime files, and `git diff --check`. Documentation updates reuse those completed runtime checks.

Only structural metadata, formats, byte counts, cue counts, and operation results are committed here. Actual episode subtitle bodies, signed CDN URLs, session credentials, and browser-profile data are excluded. The earlier [sanitized structural fixtures](observed-mechanisms.json) remain mechanism examples rather than an end-to-end compatibility promise.
