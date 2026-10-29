const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { makeContext, pruneInstallerFiles } = require('./local-release.cjs');
const root = path.resolve(__dirname, '..'), { version } = require('../package.json');
if (process.platform !== 'win32') throw Error('Windows installer builds require Windows IExpress');
execFileSync(process.execPath, [path.join(__dirname, 'verify-package.cjs')], { stdio: 'inherit' });
const release = path.join(root, 'release'), stage = fs.mkdtempSync(path.join(release, 'installer-'));
const source = path.join(release, 'v' + version, 'ASS-win32-x64'), output = path.join(release, `ASS-v${version}-win32-x64-setup.exe`);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const payload = path.join(stage, 'payload.zip');
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  // Leave the inner archive uncompressed; CAB's LZX compresses the raw runtime
  // once, instead of trying to compress an already-deflated archive again.
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ASS_INSTALLER_SOURCE, $env:ASS_INSTALLER_PAYLOAD, [IO.Compression.CompressionLevel]::NoCompression, $false)"],
  { env: { ...process.env, ASS_INSTALLER_SOURCE: source, ASS_INSTALLER_PAYLOAD: payload }, windowsHide: true, stdio: 'inherit' });
for (const name of ['install.ps1', 'uninstall.ps1']) fs.copyFileSync(path.join(__dirname, 'installer', name), path.join(stage, name));
fs.copyFileSync(path.join(__dirname, 'windows-app-identity.ps1'), path.join(stage, 'identity.ps1'));
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ appId: 'local.ass.desktop', version, payloadSha256: hash(payload), asarSha256: hash(path.join(source, 'resources/app.asar')) }));
fs.writeFileSync(path.join(stage, 'setup.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nif "%1"=="/quiet" set ASS_INSTALL_SILENT=1\r\npowershell.exe -NoProfile -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText(\'install.ps1\')))"\r\nexit /b %errorlevel%\r\n');
const names = ['payload.zip', 'manifest.json', 'install.ps1', 'uninstall.ps1', 'identity.ps1', 'setup.cmd'];
const sed = ['[Version]', 'Class=IEXPRESS', 'SEDVersion=3', '[Options]', 'PackagePurpose=InstallApp',
  'ShowInstallProgramWindow=0', 'HideExtractAnimation=1', 'UseLongFileName=1', 'InsideCompressed=0',
  'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N',
  ...['InstallPrompt','DisplayLicense','FinishMessage','TargetName','FriendlyName','AppLaunched','PostInstallCmd','AdminQuietInstCmd','UserQuietInstCmd'].map(k => `${k}=%${k}%`),
  'SourceFiles=SourceFiles', '[Strings]', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=',
  'TargetName=setup.exe', `FriendlyName=ASS ${version} Setup`, 'AppLaunched=cmd.exe /c setup.cmd', 'PostInstallCmd=<None>',
  'AdminQuietInstCmd=cmd.exe /c setup.cmd /quiet', 'UserQuietInstCmd=cmd.exe /c setup.cmd /quiet',
  ...names.map((n, i) => `FILE${i}="${n}"`), '[SourceFiles]', 'SourceFiles0=.\\',
  '[SourceFiles0]', ...names.map((_, i) => `%FILE${i}%=`), ''].join('\r\n');
const sedFile = path.join(stage, 'setup.sed'); fs.writeFileSync(sedFile, sed);
const compiler = path.join(process.env.SystemRoot, 'System32/iexpress.exe');
const result = spawnSync(compiler, ['/N', '/Q', 'setup.sed'], { cwd: stage, windowsHide: true, stdio: 'inherit', timeout: 600000 });
if (fs.existsSync(path.join(stage, 'setup.exe'))) fs.copyFileSync(path.join(stage, 'setup.exe'), output);
if (result.status !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1024 ** 2 || fs.readFileSync(output).subarray(0, 2).toString() !== 'MZ')
  throw Error(`IExpress installer build failed (exit ${result.status}; ${result.error?.message || ''}); input retained at ` + stage);
fs.writeFileSync(path.join(release, `ASS-v${version}-setup-SHA256.txt`), hash(output) + '  ' + path.basename(output) + '\n');
const removedInstallers = pruneInstallerFiles(makeContext({ root }));
console.log(JSON.stringify({ installer: output, bytes: fs.statSync(output).size, sha256: hash(output), removedInstallers }));
if (!path.resolve(stage).startsWith(path.resolve(release) + path.sep + 'installer-')) throw Error('Unexpected build cleanup path');
fs.rmSync(stage, { recursive: true, maxRetries: 3, retryDelay: 200 });
