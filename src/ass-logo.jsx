import React from "react";
import artwork from "../public/ass-logo.svg?raw";

// About-page choreography uses exactly the same geometry, not a second logo.
const aperture = artwork.match(/Z M ([\d.]+) ([\d.]+) A ([\d.]+) ([\d.]+) 0 1 0/);
export const logoAperture = aperture ? { cx: Number(aperture[1]) - Number(aperture[3]), cy: Number(aperture[2]), radius: Number(aperture[3]) } : null;
export const logoSculpture = logoAperture ? artwork
  .replace(/role="img" aria-labelledby="title"/, 'aria-hidden="true" focusable="false"')
  .replace(/<title[^>]*>.*?<\/title>/, '') : '';

// Reuse the authoritative petal geometry as an alpha mask. Only the white
// petals are recolored; the orange hub and the Windows icon stay unchanged.
const petalMask = `url("data:image/svg+xml,${encodeURIComponent(
  artwork.replace(/<path id="hub-fitted"[^>]*\/>/, ""),
)}")`;
export function AssLogo({ interactive = false }) {
  return <span className="ass-logo">
    <img src="./ass-app-icon.png" alt="ASS 菊花标志" />
    <span className="ass-logo-petals" aria-hidden="true" style={{ maskImage: petalMask }} />
    {interactive && <span className="brand-logo-color" aria-hidden="true" style={{ maskImage: petalMask }} />}
  </span>;
}
