// Authoritative vector geometry -> transparent PNG -> all Windows icon sizes.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { iconCrop } = require("./icon-layout.cjs");
const { SPEC, createGeometry, buildLogoSvg } = require("./brand-geometry.cjs");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app
  .whenReady()
  .then(async () => {
    const root = path.resolve(__dirname, "..");
    const geometry = createGeometry();
    const svg = buildLogoSvg(geometry);
    const renderer = new BrowserWindow({ width: SPEC.size, height: SPEC.size,
      useContentSize: true, show: false, frame: false, transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
    });
    let image;
    try {
      const html = `<html><head><meta charset="utf-8"><style>html,body{margin:0;width:${SPEC.size}px;height:${SPEC.size}px;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
      await renderer.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      await renderer.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      image = await renderer.webContents.capturePage({ x: 0, y: 0, width: SPEC.size, height: SPEC.size });
    } finally { renderer.destroy(); }
    if (!image || image.isEmpty()) throw new Error("Vector logo export failed");
    fs.writeFileSync(path.join(root, "public/ass-logo.svg"), svg);
    fs.writeFileSync(path.join(root, "public/ass-logo.png"), image.toPNG());
    fs.mkdirSync(path.join(root, "design/logo"), { recursive: true });
    fs.writeFileSync(path.join(root, "design/logo/ass-fitted-geometry.json"), JSON.stringify({
      source: "public/ass-logo-reference.svg", spec: SPEC,
      roots: geometry.roots.map(({ id, minimum, contour }) => ({ id, minimum, contour })),
      perimeter: geometry.perimeter, edgeKinds: geometry.facets.map(({ type, id }) => ({ type, id })), hub: geometry.hub,
    }, null, 2) + "\n");
    const { width, height } = image.getSize();
    const layout = iconCrop(image.toBitmap(), width, height);
    const icon = image.crop(layout.crop);
    // Every UI and Windows icon consumes the same tightly framed SVG export.
    fs.writeFileSync(path.join(root, "public/ass-app-icon.png"), icon.toPNG());
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const pngs = sizes.map((size) =>
      icon.resize({ width: size, height: size, quality: "best" }).toPNG(),
    );
    fs.writeFileSync(path.join(root, 'design/logo/ass-preview.png'), pngs.at(-1));
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, i) => {
      const at = 6 + i * 16;
      header[at] = size % 256;
      header[at + 1] = size % 256;
      header.writeUInt16LE(1, at + 4);
      header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(pngs[i].length, at + 8);
      header.writeUInt32LE(offset, at + 12);
      offset += pngs[i].length;
    });
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "assets/ass.ico"),
      Buffer.concat([header, ...pngs]),
    );
    console.log("Exported ASS icon: 16–256px; artwork " + (layout.occupancy * 100).toFixed(1) + "%");
    app.quit();
  })
  .catch((e) => {
    console.error(e.message);
    app.exit(1);
  });
