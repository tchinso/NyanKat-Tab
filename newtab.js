"use strict";

chrome.storage.sync.get({ disableNewTabFavoritesRedirect: false }, (settings) => {
  if (settings.disableNewTabFavoritesRedirect !== true) {
    location.replace("https://fav.ju.mp/");
  }
});
