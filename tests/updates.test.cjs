const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const {
  UpdateChecker,
  compareVersions,
  version,
  safeRelease,
  pickRelease,
  API_URL,
  RELEASES_URL,
  CHECK_INTERVAL,
  ERROR_INTERVAL,
} = require("../core/updates.cjs");
function release(
  tag = "v0.1.3",
  { prerelease = true, legacy = false, ...rest } = {},
) {
  const name = `${legacy ? "AI-Switch-Servant" : "ASS"}-v${tag.slice(1)}-win32-x64.zip`;
  return {
    tag_name: tag,
    draft: false,
    prerelease,
    html_url: `${RELEASES_URL}/tag/${tag}`,
    published_at: "2026-09-21T00:00:00Z",
    name: "ASS " + tag,
    body: "Small release notes",
    assets: [
      {
        name,
        size: 123456,
        state: "uploaded",
        browser_download_url: `${RELEASES_URL}/download/${tag}/${name}`,
        digest: "sha256:" + "a".repeat(64),
      },
    ],
    ...rest,
  };
}
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ass-updates-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new UpdateChecker({
    dataDir,
    currentVersion: "0.1.2",
    fetchRelease: async () => Response.json([release()]),
    ...options,
  });
}
test("semantic versions compare numerically and never offer a downgrade", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("v1.0.0-rc.10", "1.0.0-rc.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.99"), 1);
  assert.equal(compareVersions("1.0.0+build", "v1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-2", "1.0.0-alpha"), -1);
  for (const bad of [
    "01.2.3",
    "1.0",
    "1.0.0-01",
    "latest",
    "1.0.0/../../x",
    "999999999999999999999.1.1",
  ])
    assert.equal(version(bad), null);
});
test("release selection filters drafts, validates repository URLs, and supports both asset names", () => {
  assert.equal(safeRelease(release("v0.1.3", { draft: true })), null);
  assert.equal(
    safeRelease(release("v0.1.3", { html_url: "https://evil.example" })),
    null,
  );
  assert.equal(
    safeRelease(release()).download.name,
    "ASS-v0.1.3-win32-x64.zip",
  );
  assert.equal(
    safeRelease(release("v0.1.1", { legacy: true })).download.name,
    "AI-Switch-Servant-v0.1.1-win32-x64.zip",
  );
  const r = release();
  r.assets[0].browser_download_url = "https://evil.example/payload.zip";
  assert.equal(safeRelease(r).download, null);
  r.assets[0].browser_download_url = `${RELEASES_URL}/download/v0.1.3/ASS-v0.1.3-win32-x64.zip`;
  r.assets[0].state = "starter";
  assert.equal(safeRelease(r).download, null);
});
test("canonical GitHub release URLs remain usable after the repository rename", async (t) => {
  const page = "https://github.com/CaT-Hode/ASS-Agent-Switching-Servant/releases/tag/v0.3.0";
  const download = "https://github.com/CaT-Hode/ASS-Agent-Switching-Servant/releases/download/v0.3.0/ASS-v0.3.0-win32-x64.zip";
  const checksum = "https://github.com/CaT-Hode/ASS-Agent-Switching-Servant/releases/download/v0.3.0/SHA256SUMS.txt";
  const checker = fixture(t, {
    fetchRelease: async (url) => {
      assert.equal(url, "https://api.github.com/repos/CaT-Hode/ASS-Agent-Switching-Servant/releases?per_page=100");
      return Response.json([{
        tag_name: "v0.3.0", draft: false, prerelease: false, html_url: page,
        assets: [
          { name: "ASS-v0.3.0-win32-x64.zip", state: "uploaded", size: 123456, browser_download_url: download },
          { name: "SHA256SUMS.txt", state: "uploaded", size: 92, browser_download_url: checksum },
        ],
      }]);
    },
  });
  assert.equal((await checker.check()).available, true);
  assert.equal(checker.openUrl("release"), page);
  assert.equal(checker.openUrl("download"), download);
  assert.equal(checker.openUrl("checksum"), checksum);
  const loaded = new UpdateChecker({ dataDir: path.dirname(checker.file), currentVersion: "0.2.22" });
  assert.equal(loaded.snapshot().available, true);
  assert.equal(loaded.openUrl("download"), download);
});

test('single EXE installer takes precedence and survives update cache reload without a checksum attachment', async t => {
  const raw = release('v0.3.1', { prerelease: false });
  const name = 'ASS-v0.3.1-win32-x64-setup.exe', url = `${RELEASES_URL}/download/v0.3.1/${name}`;
  raw.assets.push({ name, state: 'uploaded', size: 123456, browser_download_url: url, digest: 'sha256:' + 'b'.repeat(64) });
  assert.equal(safeRelease(raw).download.name, name);
  const checker = fixture(t, { fetchRelease: async () => Response.json([raw]) });
  await checker.check(); assert.equal(checker.openUrl('download'), url);
  const restored = new UpdateChecker({ dataDir: path.dirname(checker.file), currentVersion: '0.3.0' });
  assert.equal(restored.openUrl('download'), url); assert.equal(restored.snapshot().latest.download.sha256, 'b'.repeat(64));
  raw.assets[1].state = 'starter'; assert.match(safeRelease(raw).download.name, /\.zip$/);
  raw.assets[1].state = 'uploaded'; raw.assets[1].browser_download_url = 'https://other.example/setup.exe';
  assert.match(safeRelease(raw).download.name, /\.zip$/);
});

test("preview channel applies GitHub flags and semantic prerelease tags, not release order", () => {
  const releases = [
    release("v0.1.9", { prerelease: false }),
    release("v0.1.10"),
    release("v1.0.0-rc.1", { prerelease: false }),
  ].map(safeRelease);
  assert.equal(pickRelease(releases, false).version, "0.1.9");
  assert.equal(pickRelease(releases, true).version, "1.0.0-rc.1");
  assert.equal(pickRelease([safeRelease(release())], false), null);
});
test("checks have no authorization, do not follow redirects, and cache ETag responses", async t => {
  let calls = 0;
  const checker = fixture(t, {
    fetchRelease: async (url, init) => {
      assert.equal(url, API_URL);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.authorization, undefined);
      if (++calls === 1)
        return Response.json([release()], {
          headers: { etag: '"fixture-etag"' },
        });
      assert.equal(init.headers["If-None-Match"], '"fixture-etag"');
      return new Response(null, { status: 304 });
    },
  });
  assert.equal((await checker.check()).available, true);
  assert.equal(
    checker.openUrl("download"),
    release().assets[0].browser_download_url,
  );
  await checker.check({ manual: true });
  assert.equal(calls, 2);
  assert.equal(checker.snapshot().status, "checked");
  const loaded = new UpdateChecker({
    dataDir: path.dirname(checker.file),
    currentVersion: "0.1.2",
    fetchRelease: checker.fetchRelease,
  });
  assert.equal(loaded.snapshot().available, true);
  assert.equal(loaded.snapshot().status, "cached");
  loaded.dismiss();
  assert.equal(loaded.snapshot().notify, false);
  assert.equal(loaded.snapshot().available, true);
  loaded.preferences({ includePreview: false });
  assert.equal(loaded.snapshot().available, false);
});
test("automatic checks honor six-hour interval and disabled preference; manual checks remain available", async t => {
  let clock = 100000000,
    calls = 0;
  const checker = fixture(t, {
    now: () => clock,
    fetchRelease: async () => {
      calls++;
      return Response.json([release()]);
    },
  });
  await checker.check();
  await checker.check();
  assert.equal(calls, 1);
  clock += CHECK_INTERVAL;
  await checker.check();
  assert.equal(calls, 2);
  checker.preferences({ automatic: false });
  clock += CHECK_INTERVAL;
  await checker.check();
  assert.equal(calls, 2);
  await checker.check({ manual: true });
  assert.equal(calls, 3);
  const loaded = new UpdateChecker({
    dataDir: path.dirname(checker.file),
    currentVersion: "0.1.2",
    now: () => clock,
    fetchRelease: checker.fetchRelease,
  });
  assert.equal(loaded.snapshot().automatic, false);
});
test("concurrent checks share one request and cancellation cannot revive an old notification", async t => {
  let resolve,
    calls = 0;
  const checker = fixture(t, {
    fetchRelease: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const a = checker.check(),
    b = checker.check({ manual: true });
  assert.equal(a, b);
  assert.equal(calls, 1);
  checker.preferences({ automatic: false });
  resolve(Response.json([release()]));
  await a;
  assert.equal(checker.snapshot().available, false);
  assert.notEqual(checker.snapshot().status, "checking");
});
test("network failure retains only cached metadata and applies retry backoff", async t => {
  let clock = 10000000;
  const checker = fixture(t, { now: () => clock });
  await checker.check();
  checker.fetchRelease = async () => {
    throw Error("secret upstream detail");
  };
  await checker.check({ manual: true });
  assert.equal(checker.snapshot().status, "error");
  assert.equal(checker.snapshot().available, true);
  assert.equal(checker.snapshot().nextAutomaticAt, clock + ERROR_INTERVAL);
  assert.ok(!checker.snapshot().message.includes("secret"));
});
test("GitHub rate-limit headers gate manual and scheduled retries", async t => {
  let clock = 10000000,
    calls = 0;
  const checker = fixture(t, {
    now: () => clock,
    fetchRelease: async () => {
      calls++;
      return new Response(null, {
        status: 429,
        headers: { "retry-after": "3600" },
      });
    },
  });
  await checker.check();
  assert.equal(checker.snapshot().retryAt, clock + 3600000);
  await checker.check({ manual: true });
  assert.equal(calls, 1);
  clock += 3600000;
  await checker.check();
  assert.equal(calls, 2);
  const longLimit = fixture(t, {
    now: () => clock,
    fetchRelease: async () =>
      new Response(null, { status: 429, headers: { "retry-after": "172800" } }),
  });
  await longLimit.check();
  const reloaded = new UpdateChecker({
    dataDir: path.dirname(longLimit.file),
    currentVersion: "0.1.2",
    now: () => clock,
    fetchRelease: longLimit.fetchRelease,
  });
  assert.equal(reloaded.snapshot().retryAt, clock + 172800000);
});
test("malformed and oversized API bodies fail closed without executable release content", async t => {
  for (const body of [
    { message: "not releases" },
    [{ tag_name: "bad-version" }],
  ]) {
    const checker = fixture(t, { fetchRelease: async () => Response.json(body) });
    await checker.check();
    assert.equal(checker.snapshot().status, "error");
  }
  const checker = fixture(t, {
    fetchRelease: async () => new Response(" ".repeat(8 * 1024 * 1024 + 1)),
  });
  await checker.check();
  assert.equal(checker.snapshot().status, "error");
  assert.throws(() => checker.openUrl("download"));
  assert.throws(() => checker.openUrl("https://evil.example"));
});
test("startup timer schedules a non-blocking check, timer stop cancels it", async t => {
  const pending = new Map();
  let id = 0,
    calls = 0;
  const timers = {
    setTimeout: (fn, ms) => {
      const key = ++id;
      pending.set(key, { fn, ms });
      return key;
    },
    clearTimeout: (key) => pending.delete(key),
  };
  const checker = fixture(t, {
    timers,
    fetchRelease: async () => {
      calls++;
      return Response.json([]);
    },
  });
  checker.start();
  checker.start();
  assert.equal(pending.size, 1);
  assert.equal(pending.get(1).ms, 10000);
  pending.delete(1);
  const tick = checker.timer;
  assert.equal(tick, 1);
  // Start a fresh scheduler after cancelling; then execute the scheduled callback.
  checker.stop();
  checker.start();
  const entry = pending.get(checker.timer);
  pending.delete(checker.timer);
  entry.fn();
  await checker.pending;
  assert.equal(calls, 1);
  assert.equal([...pending.values()][0].ms, 60000);
  checker.stop();
  assert.equal(pending.size, 0);
});
test("no downgrade, no missing Windows package download, and new releases notify after dismissal", async t => {
  const checker = fixture(t, { currentVersion: "0.2.0" });
  await checker.check();
  assert.equal(checker.snapshot().available, false);
  assert.throws(() => checker.openUrl("download"));
  checker.fetchRelease = async () =>
    Response.json([release("v0.3.0", { assets: [] })]);
  await checker.check({ manual: true });
  assert.equal(checker.snapshot().available, true);
  assert.throws(() => checker.openUrl("download"));
  checker.dismiss();
  checker.fetchRelease = async () => Response.json([release("v0.4.0")]);
  await checker.check({ manual: true });
  assert.equal(checker.snapshot().notify, true);
});
