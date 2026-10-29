const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readDesktopJson } = require("../core/desktop-metadata.cjs");
const { archiveBuffer } = require("./helpers/asar-fixture.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ass-desktop-metadata-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = path.join(root, "app.asar"), file = path.join(archive, "package.json");
  const write = (header, data) => fs.writeFileSync(archive, archiveBuffer(header, data));
  const pack = (value) => {
    const data = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    write({ files: { "package.json": { size: data.length, offset: "0" } } }, data);
  };
  return { root, archive, file, write, pack };
}

test("packed and nested JSON reads are fresh after replacing the archive", (t) => {
  const f = fixture(t);
  f.pack({ name: "@zcode/desktop", version: "3.14.0" });
  assert.equal(readDesktopJson(f.file).version, "3.14.0");
  fs.renameSync(f.archive, f.archive + ".old");
  f.pack({ version: "3.15.0" });
  assert.equal(readDesktopJson(f.file).version, "3.15.0");
  const data = Buffer.from('{"appVersion":"3.16.0"}');
  f.write({ files: { out: { files: { metadata: { files: { "build-meta.json": { size: data.length, offset: "0" } } } } } } }, data);
  assert.deepEqual(readDesktopJson(path.join(f.archive, "out/metadata/build-meta.json")), { appVersion: "3.16.0" });
});

test("plain JSON, real app.asar directories and unpacked entries are bounded", (t) => {
  const f = fixture(t), plain = path.join(f.root, "package.json");
  fs.writeFileSync(plain, '{"version":"3.14.0"}');
  assert.equal(readDesktopJson(plain).version, "3.14.0");
  fs.mkdirSync(f.archive);
  fs.writeFileSync(f.file, '{"name":"desktop"}');
  assert.deepEqual(readDesktopJson(f.file), { name: "desktop" });
  fs.unlinkSync(f.file); fs.rmdirSync(f.archive);
  const data = Buffer.from('{"version":"3.15.0"}');
  f.write({ files: { "package.json": { size: data.length, unpacked: true } } });
  fs.mkdirSync(f.archive + ".unpacked");
  fs.writeFileSync(path.join(f.archive + ".unpacked", "package.json"), data);
  assert.equal(readDesktopJson(f.file).version, "3.15.0");
  assert.deepEqual(readDesktopJson(f.file, data.length - 1), {});
  assert.deepEqual(readDesktopJson(plain, 3), {});
  fs.writeFileSync(path.join(f.archive + ".unpacked", "package.json"), Buffer.alloc(513 * 1024));
  assert.deepEqual(readDesktopJson(f.file), {}); // Actual unpacked size, not just header size.
});

test("malformed framing, header lengths and truncated data fail closed", (t) => {
  const f = fixture(t);
  const valid = archiveBuffer({ files: { "package.json": { size: 2, offset: "0" } } }, Buffer.from("{}"));
  const cases = [Buffer.alloc(0), Buffer.from("invalid"), valid.subarray(0, 10), valid.subarray(0, valid.length - 1)];
  for (const [position, value] of [[0, 8], [4, 0xffffffff], [4, 16 * 1024 * 1024 + 4], [8, 0], [12, 0xffffffff]]) {
    const bad = Buffer.from(valid); bad.writeUInt32LE(value, position); cases.push(bad);
  }
  const invalidJson = Buffer.from(valid); invalidJson[16] = 0xff; cases.push(invalidJson);
  for (const bad of cases) {
    fs.writeFileSync(f.archive, bad);
    assert.deepEqual(readDesktopJson(f.file), {});
  }
});

test("invalid entry types, offsets, sizes, links and missing paths fail closed", (t) => {
  const f = fixture(t);
  for (const entry of [null, [], {}, { files: {} }, { link: "package.json" },
    { offset: "-1", size: 2 }, { offset: "1.5", size: 2 }, { offset: 0, size: 2 },
    { offset: "9007199254740993", size: 2 }, { offset: "99", size: 2 },
    { offset: "0", size: -1 }, { offset: "0", size: 1.5 }, { offset: "0", size: 513 * 1024 },
    { offset: "0", size: "2" }, { offset: "0", size: 2, unpacked: "true" },
    { offset: "0", size: 2, link: "../../package.json" }]) {
    f.write({ files: { "package.json": entry } }, Buffer.from("{}"));
    assert.deepEqual(readDesktopJson(f.file), {});
  }
  for (const value of ["null", "[]", "true", "123", "bad-json"]) {
    f.pack(value); assert.deepEqual(readDesktopJson(f.file), {});
  }
  f.pack({ name: "desktop" });
  assert.deepEqual(readDesktopJson(path.join(f.archive, "missing.json")), {});
  assert.deepEqual(readDesktopJson(path.join(f.root, "missing.json")), {});
  assert.deepEqual(readDesktopJson(f.archive + path.sep + ".." + path.sep + "package.json"), {});
  assert.deepEqual(readDesktopJson("relative.json"), {});
  assert.deepEqual(readDesktopJson(f.file, Infinity), {});
  assert.deepEqual(readDesktopJson(f.file, 513 * 1024), {});
  assert.deepEqual(readDesktopJson(f.file, 0), {});
});

test("archive directory links and physical linked paths are not followed", (t) => {
  const f = fixture(t);
  f.write({ files: { out: { link: "elsewhere", files: { "package.json": { offset: "0", size: 2 } } } } }, Buffer.from("{}"));
  assert.deepEqual(readDesktopJson(path.join(f.archive, "out/package.json")), {});
  const real = path.join(f.root, "real"), linked = path.join(f.root, "linked");
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, "package.json"), '{"name":"linked"}');
  fs.symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(readDesktopJson(path.join(linked, "package.json")), {});
  f.write({ files: { "package.json": { size: 17, unpacked: true } } });
  fs.symlinkSync(real, f.archive + ".unpacked", process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(readDesktopJson(f.file), {});
});

test("every owned descriptor closes on success, missing entries and failures", (t) => {
  const f = fixture(t), open = fs.openSync, close = fs.closeSync, read = fs.readSync;
  const owned = new Set(); let opens = 0, closes = 0, bytes = 0, failRead = false;
  fs.openSync = (...args) => { const fd = open(...args); owned.add(fd); opens++; return fd; };
  fs.closeSync = (fd) => { assert.ok(owned.delete(fd)); closes++; return close(fd); };
  fs.readSync = (...args) => {
    if (failRead) throw Error("synthetic read failure");
    // Force short reads: the reader must fill its bounded buffer completely.
    args[3] = Math.min(args[3], 7);
    const count = read(...args); bytes += count; return count;
  };
  try {
    f.pack({ version: "3.14.0" });
    // A large sparse archive must not cause a whole-archive read.
    fs.truncateSync(f.archive, 128 * 1024 * 1024);
    assert.equal(readDesktopJson(f.file).version, "3.14.0");
    assert.ok(bytes < 2048);
    assert.deepEqual(readDesktopJson(path.join(f.archive, "missing.json")), {});
    assert.deepEqual(readDesktopJson(f.file, 3), {});
    fs.writeFileSync(f.archive, Buffer.from("malformed framing"));
    assert.deepEqual(readDesktopJson(f.file), {});
    f.pack({ version: "3.14.0" });
    failRead = true; assert.deepEqual(readDesktopJson(f.file), {});
    failRead = false; f.pack("bad-json"); assert.deepEqual(readDesktopJson(f.file), {});
    const plain = path.join(f.root, "plain.json");
    fs.writeFileSync(plain, '{"version":"3.15.0"}');
    assert.equal(readDesktopJson(plain).version, "3.15.0");
    assert.deepEqual(readDesktopJson(plain, 3), {});
    f.write({ files: { "package.json": { size: 20, unpacked: true } } });
    fs.mkdirSync(f.archive + ".unpacked");
    const unpacked = path.join(f.archive + ".unpacked", "package.json");
    fs.writeFileSync(unpacked, '{"version":"3.16.0"}');
    assert.equal(readDesktopJson(f.file).version, "3.16.0");
    fs.writeFileSync(unpacked, "bad-json");
    assert.deepEqual(readDesktopJson(f.file), {});
    assert.equal(owned.size, 0); assert.equal(opens, closes);
  } finally { fs.openSync = open; fs.closeSync = close; fs.readSync = read; }
});

test("ZCode metadata keeps build-meta precedence and validates package fallback", (t) => {
  const f = fixture(t), { zcodeVersion } = require("../core/oauth-info.cjs");
  // The API expects <install>/resources/app.asar; our ASAR fixture is moved there.
  fs.mkdirSync(path.join(f.root, "resources"));
  const archive = path.join(f.root, "resources/app.asar");
  const manager = { launcher: () => ({ desktopExecutable: path.join(f.root, "ZCode.exe") }) };
  f.pack({ name: "@zcode/desktop", version: "3.14.0" }); fs.renameSync(f.archive, archive);
  assert.equal(zcodeVersion(manager), "3.14.0");
  assert.equal(zcodeVersion({ launcher: () => ({ version: "3.17.0", desktopExecutable: manager.launcher().desktopExecutable }) }), "3.17.0");
  const pkg = Buffer.from('{"name":"@zcode/desktop","version":"3.14.0"}');
  for (const value of ["3.15.0", "invalid-version"]) {
    const build = Buffer.from(JSON.stringify({ appVersion: value }));
    fs.writeFileSync(archive, archiveBuffer({ files: { "package.json": { size: pkg.length, offset: "0" },
      out: { files: { metadata: { files: { "build-meta.json": { size: build.length, offset: String(pkg.length) } } } } } } }, Buffer.concat([pkg, build])));
    assert.equal(zcodeVersion(manager), value === "3.15.0" ? value : "3.14.0");
  }
  f.pack({ name: "wrong-desktop", version: "3.14.0" }); fs.renameSync(f.archive, archive);
  assert.equal(zcodeVersion(manager), null);
});
