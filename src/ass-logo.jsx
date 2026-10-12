import React from "react";
import artwork from "../public/ass-logo.svg?raw";

// Reuse the authoritative petal geometry as an alpha mask. Only the white
// petals are recolored; the orange hub and the Windows icon stay unchanged.
const petalMask = `url("data:image/svg+xml,${encodeURIComponent(
  artwork.replace(/<path id="hub-fitted"[^>]*\/>/, ""),
)}")`;
export function AssLogo() {
  return <span className="ass-logo">
    <img src="./ass-app-icon.png" alt="ASS 菊花标志" />
    <span className="ass-logo-petals" aria-hidden="true" style={{ maskImage: petalMask }} />
  </span>;
}
