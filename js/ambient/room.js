// Ambient room mode: cross-faded artwork frame.

import { elements } from "../dom.js";

// Room-mode artwork crossfade: two stacked <img> layers inside the art frame.
// On a real artwork change we load the new art into the hidden layer first,
// then flip data-art-active so CSS crossfades opacity (~600ms, transform/opacity
// only — TV-safe). renderAmbient runs on every playback update, so the URL
// guard keeps this a no-op unless the artwork actually changed.
const _roomArtState = { url: "", active: "a" };
function updateAmbientRoomArt(image) {
  const frame = elements.ambientRoomArtFrame;
  const a = elements.ambientRoomArt;
  const b = elements.ambientRoomArtB;
  if (!a) return;
  if (!frame || !b) {
    // No B layer in the DOM — fall back to the old direct swap.
    if (image) a.src = image;
    else a.removeAttribute("src");
    return;
  }
  if (image === _roomArtState.url) return;
  const hadArt = Boolean(_roomArtState.url);
  _roomArtState.url = image;
  if (!image) {
    _roomArtState.active = "a";
    frame.dataset.artActive = "a";
    a.removeAttribute("src");
    b.removeAttribute("src");
    return;
  }
  if (!hadArt) {
    // First artwork of the session: nothing to crossfade from, show directly.
    const visible = _roomArtState.active === "b" ? b : a;
    visible.src = image;
    return;
  }
  const incomingKey = _roomArtState.active === "a" ? "b" : "a";
  const incoming = incomingKey === "b" ? b : a;
  incoming.onload = () => {
    incoming.onload = null;
    if (_roomArtState.url !== image) return; // a newer track superseded this load
    _roomArtState.active = incomingKey;
    frame.dataset.artActive = incomingKey;
  };
  incoming.src = image;
}

export { updateAmbientRoomArt };
