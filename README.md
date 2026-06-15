
<p align="center">
  <a href="https://chromewebstore.google.com/detail/ecnmaciilbmjkhakjnhbfbijffgdmoib">
    <img src="https://img.shields.io/badge/🚀_Install_Chrome_Extension-Chrome_Web_Store-4285F4?style=for-the-badge" />
  </a>
</p>

# NyanKatX3 Tab

Chrome MV3 extension for:

- replacing the new tab page with `https://fav.ju.mp/`
- falling back from `https://fav.ju.mp/` to `https://12tw.pages.dev/`, then to `https://tchinso.github.io/fav/` when navigation fails
- sending a `0` key event after YouTube watch pages load
- decoding selected Base64 text from the `NyanKatX3 Tab` right-click menu, including up to three nested Base64 layers
- starting smooth automatic scrolling with a right-button vertical mouse gesture
- persisting the YouTube and auto-scroll settings across browser restarts

## Permissions

- `contextMenus`: adds the `NyanKatX3 Tab > Base64 해독` menu for selected page text.
- `storage`: saves the popup settings.
- `webNavigation`: detects failed top-level navigations to the primary and first fallback URLs.
- `content_scripts.matches` for `https://www.youtube.com/*`: runs the YouTube watch-page helper.
- `content_scripts.matches` for `http://*/*` and `https://*/*`: displays the local Base64 decode result and runs the mouse-gesture auto-scroll helper on normal web pages.

No `tabs`, `scripting`, `activeTab`, `clipboardWrite`, `notifications`, `webRequest`, or remote-code permissions are requested. Base64 decoding runs locally and does not transmit selected text.

## Chrome Web Store notes

- Do not include `Base64Decoder/` in the uploaded Web Store ZIP. It is a reference MV2 extension only, and unused extension code can make review harder.
- Keep the Web Store listing and privacy fields aligned with the shipped behavior: new tab redirect, fallback navigation, YouTube start helper, local selected-text Base64 decoding, and mouse-gesture auto scrolling.

## Icons

The extension uses PNG files extracted directly from the supplied `.ico` icon files so Chrome UI and Chrome Web Store rendering do not fall back to the default extension icon.
