import { packager } from "@electron/packager";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import layout from "./package-layout.cjs";
import localRelease from "./local-release.cjs";
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
localRelease.prePackageGuard({ root });
execFileSync(process.execPath, [path.join(root, 'scripts/build-desktop-glass.cjs')], { stdio: 'inherit', windowsHide: true });
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const notices = [];
for (const [relative, entry] of Object.entries(lock.packages)) {
  if (!relative.startsWith("node_modules/") || entry.dev) continue;
  for (const file of await readdir(path.join(root, relative))) {
    if (/^(?:licen[cs]e|copying)(?:\.[^/]*)?$/i.test(file))
      notices.push(`${relative.slice(13)} ${entry.version}\n${await readFile(path.join(root, relative, file), "utf8")}`);
  }
}
const outputs = await packager({
  dir: root,
  name: "ASS",
  executableName: "ASS",
  appCopyright: "ASS · Agent-Switching-Servant",
  win32metadata: { FileDescription: "Agent-Switching-Servant", ProductName: "ASS" },
  icon: fileURLToPath(new URL("../assets/ass.ico", import.meta.url)),
  extraResource: [fileURLToPath(new URL("../assets/ass.ico", import.meta.url)), path.join(root, 'native/bin/desktop-glass')],
  asar: true,
  platform: "win32",
  arch: "x64",
  // Verify cached/downloaded archives against this pinned Electron package.
  // An explicit build cache also supports offline builds after a host move.
  download: {
    checksums: JSON.parse(await readFile(new URL("../node_modules/electron/checksums.json", import.meta.url), "utf8")),
    ...(process.env.ASS_ELECTRON_CACHE ? { cacheRoot: process.env.ASS_ELECTRON_CACHE } : {}),
  },
  out: fileURLToPath(new URL("../release/v" + version, import.meta.url)),
  overwrite: true,
  tmpdir: false,
  prune: false, // The runtime whitelist replaces dependency-based pruning.
  ignore: (name) => !layout.allowed(name),
  beforeAsar: [async ({ buildPath }) => {
    const app = buildPath;
    const main = path.join(app, "electron", "main.cjs");
    await writeFile(main, layout.productionMain(await readFile(main, "utf8")));
    const manifest = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
    delete manifest.scripts;
    delete manifest.devDependencies;
    manifest.dependencies = Object.fromEntries(layout.runtimeDependencies.map(name => [name, manifest.dependencies[name]]));
    await writeFile(path.join(app, "package.json"), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(app, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n----------------------------------------\n\n"));
    for (const dependency of layout.runtimeDependencies) {
      const file = path.join(app, "node_modules", dependency, "package.json");
      const metadata = JSON.parse(await readFile(file, "utf8"));
      for (const key of ['scripts', 'devDependencies', 'directories', 'prettier', 'browserslist', 'typings']) delete metadata[key];
      await writeFile(file, JSON.stringify(metadata, null, 2));
    }
  }],
  // Windows scanners can briefly hold the just-extracted runtime open.
  // Give those handles time to close before Packager renames the directory.
  afterExtract: [
    async () => {
      await setTimeout(8000);
    },
  ],
});
for (const output of outputs) console.log("Packaged: " + output);
