const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ensureDesktopProfile, redirectedProfile, quoteArg, RELAUNCH_FLAG } = require('../core/windows-profile.cjs');

function fixture(t, redirected = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ass-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'profile');
  const io = redirected ? { ...fs, realpathSync: { native: file => 'C:\\Users\\test\\AppData\\Local\\Packages\\any.launcher_123\\LocalCache\\Roaming\\ASS\\' + path.basename(file) } } : fs;
  return { root, directory, io, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } };
}

test('physical profile keeps existing settings and removes its location probe', t => {
  const f = fixture(t); fs.mkdirSync(f.directory);
  fs.writeFileSync(path.join(f.directory, 'settings.json'), 'unchanged');
  assert.equal(ensureDesktopProfile({ ...f, run: () => assert.fail('unexpected relaunch') }), false);
  assert.deepEqual(fs.readdirSync(f.directory), ['settings.json']);
  assert.equal(fs.readFileSync(path.join(f.directory, 'settings.json'), 'utf8'), 'unchanged');
});

test('redirected first write is detected and an empty probe directory is removed', t => {
  const f = fixture(t, true);
  assert.equal(redirectedProfile(f.directory, f.io), true);
  assert.equal(fs.existsSync(f.directory), false);
  assert.equal(redirectedProfile(f.directory, f.io), true);
  assert.equal(fs.existsSync(f.directory), false);
});

test('an existing shadow setting is detected even when new writes are physical', t => {
  const f = fixture(t); fs.mkdirSync(f.directory);
  const file = path.join(f.directory, 'settings.json'); fs.writeFileSync(file, 'saved');
  const io = { ...fs, realpathSync: { native: name => name === file
    ? 'C:\\Users\\test\\AppData\\Local\\Packages\\launcher_123\\LocalCache\\Roaming\\ASS\\settings.json'
    : fs.realpathSync.native(name) } };
  assert.equal(redirectedProfile(f.directory, io), true);
  assert.deepEqual(fs.readdirSync(f.directory), ['settings.json']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'saved');
});

test('desktop handoff preserves the executable, arguments and working directory', t => {
  const f = fixture(t, true), executable = 'C:\\Apps With Spaces\\ASS.exe';
  let calls = 0;
  assert.equal(ensureDesktopProfile({ ...f, executable, args: ['--flag', 'a"b\\'], cwd: f.root,
    run(command, args, options) {
      calls++; assert.match(command, /WindowsPowerShell/); assert.equal(options.windowsHide, true);
      const input = JSON.parse(options.input);
      assert.equal(input.executable, executable); assert.equal(input.cwd, f.root);
      assert.equal(input.arguments, ['--flag', 'a"b\\', RELAUNCH_FLAG].map(quoteArg).join(' '));
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.match(script, /FindWindowSW/); assert.match(script, /Document\.Application\.ShellExecute/);
      return { status: 0 };
    } }), true);
  assert.equal(calls, 1);
});

test('failed desktop dispatch and repeated redirection refuse to create another profile', t => {
  const f = fixture(t, true);
  assert.throws(() => ensureDesktopProfile({ ...f, args: [], run: () => ({ status: 1 }) }), /无法通过 Windows/);
  assert.throws(() => ensureDesktopProfile({ ...f, args: [RELAUNCH_FLAG], run: () => assert.fail('loop') }), /仍将 ASS 数据/);
  assert.equal(fs.existsSync(f.directory), false);
});

test('explicit profiles and non-Windows launches do not probe or relaunch', t => {
  const f = fixture(t, true);
  for (const opts of [{ explicit: true }, { platform: 'linux' }])
    assert.equal(ensureDesktopProfile({ ...f, ...opts, run: () => assert.fail('unexpected relaunch') }), false);
  assert.equal(fs.existsSync(f.directory), false);
});
