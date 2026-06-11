// Library view: playlists, saved albums, saved tracks shelves.

import { spotifyApiJson } from "../api.js";
import { requireAccessToken } from "../auth.js";
import { renderShelf } from "../cards.js";
import { elements } from "../dom.js";
import { splitPlaylists } from "./home.js";

async function loadLibrary() {
  requireAccessToken();
  const [playlists, albums, tracks] = await Promise.all([
    spotifyApiJson("/v1/me/playlists?limit=50"),
    spotifyApiJson("/v1/me/albums?limit=24"),
    spotifyApiJson("/v1/me/tracks?limit=24"),
  ]);
  const { own } = splitPlaylists(playlists.items || []);
  renderShelf(elements.playlistShelf, "Your Playlists", own, "playlist");
  renderShelf(elements.libraryAlbumsShelf, "Albums", (albums.items || []).map((item) => item.album), "album");
  renderShelf(elements.libraryTracksShelf, "Saved Tracks", (tracks.items || []).map((item) => item.track), "track");
}

export { loadLibrary };
