# NyanKatX3 Tab

Chrome MV3 extension for:

- replacing the new tab page with `https://fav.ju.mp/`
- falling back from `https://fav.ju.mp/` to `https://12tw.pages.dev/`, then to `https://tchinso.github.io/fav/` when navigation fails
- sending a `0` key event after YouTube watch pages load
- decoding selected Base64 text from the `NyanKatX3 Tab` right-click menu, including up to three nested Base64 layers
- automatically decoding detected Base64 text on `kone.gg`, with nested decoding, clickable links, copy buttons, and original text reveal
- showing site-specific floating auto-scroll buttons for configured hosts
- unlocking disabled `button` elements on `kio.ac` and showing detected `B/s)` download status text in the extension page `kiodownload.html`
- persisting the YouTube, kone.gg decoder, and floating scroll settings across browser restarts

## Permissions

- `contextMenus`: adds the `NyanKatX3 Tab > Base64 디코딩` menu for selected page text.
- `storage`: saves the popup and floating-scroll settings, and keeps the temporary kio.ac detection snapshot in session storage.
- `webNavigation`: detects failed top-level navigations to the primary and first fallback URLs.
- `content_scripts.matches` for `https://www.youtube.com/*`: runs the YouTube watch-page helper.
- `content_scripts.matches` for `https://kone.gg/*` and `https://*.kone.gg/*`: runs the automatic Base64 decoder only on kone.gg pages.
- `content_scripts.matches` for `https://kio.ac/*` and `https://*.kio.ac/*`: unlocks disabled buttons and detects `B/s)` text only on kio.ac pages.
- `content_scripts.matches` for `http://*/*` and `https://*/*`: displays the local Base64 decode result in any selected frame and shows floating auto-scroll buttons on configured hosts or on sites covered by the default scroll setting.

No `tabs`, `scripting`, `activeTab`, `clipboardWrite`, `notifications`, `webRequest`, or remote-code permissions are requested. Base64 decoding and kio.ac status detection run locally and do not transmit selected text or page text to remote services.

## Chrome Web Store notes

- Keep the Web Store listing and privacy fields aligned with the shipped behavior: new tab redirect, fallback navigation, YouTube start helper, local Base64 decoding, configured-site floating auto scrolling, kone.gg Base64 helper, and local kio.ac download status detection.

## Icons

The extension uses PNG files extracted directly from the supplied `.ico` icon files so Chrome UI and Chrome Web Store rendering do not fall back to the default extension icon.
