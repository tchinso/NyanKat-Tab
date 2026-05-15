# NyanKatX3 Tab

Chrome MV3 extension for:

- replacing the new tab page with `https://fav.ju.mp/`
- falling back from `https://fav.ju.mp/` to `https://12tw.pages.dev/`, then to `https://tchinso.github.io/fav/` when navigation fails
- sending a `0` key event after YouTube watch pages load
- ignoring upward mouse-wheel scrolling while preserving downward scrolling
- persisting the YouTube and wheel settings across browser restarts

## Permissions

- `storage`: saves the two popup toggles.
- `webNavigation`: detects failed top-level navigations to the primary and first fallback URLs.
- `content_scripts.matches` for `https://www.youtube.com/*`: runs the YouTube watch-page helper.
- `content_scripts.matches` for `http://*/*` and `https://*/*`: runs the global wheel filter on normal web pages.

No `tabs`, `scripting`, `activeTab`, `webRequest`, or remote-code permissions are requested.

## Icons

The extension uses PNG files extracted directly from the supplied `.ico` icon files so Chrome UI and Chrome Web Store rendering do not fall back to the default extension icon.
