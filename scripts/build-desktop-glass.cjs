const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), cache = path.join(root, 'native/build/dependencies');
const nodeVersion = '24.21.0', electronVersion = require('../node_modules/electron/package.json').version;
fs.mkdirSync(cache, { recursive: true });
function download(url, file) {
  if (fs.existsSync(file)) return;
  execFileSync('curl.exe', ['--fail', '--location', '--silent', '--show-error', url, '--output', file], { stdio: 'inherit', windowsHide: true });
}
const headers = path.join(cache, 'node-v' + nodeVersion + '/include/node');
if (!fs.existsSync(path.join(headers, 'node_api.h'))) {
  const archive = path.join(cache, 'node-headers.tar.gz');
  download(`https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-headers.tar.gz`, archive);
  execFileSync('tar.exe', ['-xf', archive, '-C', cache], { stdio: 'inherit', windowsHide: true });
}
const library = path.join(cache, `electron-${electronVersion}-node.lib`);
download(`https://artifacts.electronjs.org/headers/dist/v${electronVersion}/win-x64/node.lib`, library);
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
const cmake = path.join(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe');
const build = path.join(root, 'native/build');
execFileSync(cmake, ['-S', path.join(root, 'native'), '-B', build, '-A', 'x64', '-DNODE_INCLUDE=' + headers, '-DNODE_LIBRARY=' + library], { stdio: 'inherit', windowsHide: true });
execFileSync(cmake, ['--build', build, '--config', 'Release', '--parallel', '4'], { stdio: 'inherit', windowsHide: true });
const output = path.join(root, 'native/bin/desktop-glass');fs.mkdirSync(output, { recursive: true });
for (const [source, name] of [['Release/RequestGlass.node', 'RequestGlass.node'], ['desktop-glass/Release/DesktopGlass.dll', 'DesktopGlass.dll']])
  fs.copyFileSync(path.join(build, source), path.join(output, name));
console.log('Built desktop sampling and refraction: ' + output);
