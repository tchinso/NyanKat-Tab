# NyanKatX3 Tab

Chrome MV3 extension for:

- replacing the new tab page with `https://fav.ju.mp/`
- falling back from `https://fav.ju.mp/` to `https://12tw.pages.dev/`, then to `https://tchinso.github.io/fav/` when navigation fails
- sending a `0` key event after YouTube watch pages load
- decoding selected Base64 text from the `NyanKatX3 Tab` right-click menu, including up to three nested Base64 layers
- automatically decoding detected Base64 text on `kone.gg`, with nested decoding, clickable links, copy buttons, and original text reveal
- showing floating auto-scroll buttons with configurable opacity and site exclusions
- downloading detected soft subtitles from the popup's separate **자막추출** tab
- applying local subtitles to videos using the existing **자막** overlay tab
- unlocking disabled `button` elements, closing newly opened tooltips and the Kiosk support popup, and showing detected `B/s)` download status text from `kio.ac` in the extension page `kiodownload.html`
- persisting the YouTube, kone.gg decoder, and floating scroll settings across browser restarts

## Permissions

- `contextMenus`: adds the `NyanKatX3 Tab > Base64 디코딩` menu for selected page text.
- `storage`: saves the popup and floating-scroll settings, and keeps the temporary kio.ac detection snapshot in session storage.
- `webNavigation`: detects failed top-level navigations to the primary and first fallback URLs.
- `webRequest`: observes subtitle/manifest response URLs in the current tab, including embedded players and worker requests. It does not intercept video bodies.
- `downloads`: saves validated subtitle files after the user presses **다운로드**.
- `host_permissions` for HTTP(S): reads discovered subtitle files and subtitle manifests from their CDN origins.
- `content_scripts.matches` for `https://www.youtube.com/*`: runs the YouTube watch-page helper.
- `content_scripts.matches` for `https://kone.gg/*` and `https://*.kone.gg/*`: runs the automatic Base64 decoder only on kone.gg pages.
- `content_scripts.matches` for `https://kio.ac/*` and `https://*.kio.ac/*`: unlocks disabled buttons, resets newly opened tooltip triggers, and detects `B/s)` text only on kio.ac pages.
- `content_scripts.matches` for `http://*/*` and `https://*/*`: displays the local Base64 decode result in the selected frame. The floating auto-scroll buttons are shown once in the top-level page on configured hosts or sites covered by the default scroll setting.

No `tabs`, `scripting`, `activeTab`, `clipboardWrite`, `notifications`, or remote-code permissions are requested. Subtitle discovery and parsing run locally; downloading only requests the discovered resources from their original sites/CDNs. Subtitle bodies are kept in a bounded page-memory cache, and temporary discovery metadata is kept in extension session storage. Nothing is uploaded to a separate extraction service.

## Soft-subtitle downloads

Reload the extension and the playback page after upgrading. Open the site's player, enable its subtitles, then open the extension's **자막추출** tab. The list updates while the popup is open; **자막 다시 검색** also checks all player frames. Select a language and press **다운로드** to choose where to save the file. Reading and saving run in the background worker, so closing the popup does not cancel an already requested download.

The engine observes HTML tracks, loaded native cues, player configuration/JSON, fetch/XHR responses, caption Blobs, renderer messages, and streaming manifests. It handles ordinary and nested player frames, shadow roots, opaque URLs, and CDN responses with misleading MIME types. Known chapter/storyboard/thumbnail tracks and non-subtitle bodies are excluded. No host-specific allowlist is used.

- Direct VTT, SRT, ASS/SSA, TTML/DFXP, SMI/SAMI and SBV files retain their original text, including ASS styling. Timed JSON is exported to VTT.
- Complete HLS WebVTT subtitle playlists are gathered in playlist order and exported to one VTT with timestamp-map alignment and duplicate removal.
- DASH text adaptations can expose direct files or finite plain-text subtitle segments. Selected representations are gathered into VTT.
- Native cue exports explicitly show **로드된 구간만** when completeness cannot be established. Those files include `loaded-cues` in their names.
- Live/sliding playlists, encrypted streams, byte-range tracks, and subtitles in binary MP4 initialization/fragment streams are rejected rather than saved as a complete subtitle. Burned-in subtitles/OCR are outside this feature.

Each fetched resource is limited to 4 MiB; gathered subtitles are limited to 24 MiB. The engine validates timed content before saving, retries transient CDN errors, preserves the originating player context when reading captions, and clears stale discoveries on navigation. Sites that block a request may require enabling the desired caption language so the player loads it first.

Run the automated checks with `node --test`. See [site validation](tests/fixtures/subtitle-sites/README.md) for observed player mechanisms and the limits of the live-site verification.

## Chrome Web Store notes

- Keep the Web Store listing and privacy fields aligned with the shipped behavior, including subtitle detection/downloads and their HTTP(S), webRequest, and downloads permissions.

## Icons

The extension uses PNG files extracted directly from the supplied `.ico` icon files so Chrome UI and Chrome Web Store rendering do not fall back to the default extension icon.
