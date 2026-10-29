// One WSL TCP connection, carried over interop stdio to the Windows loopback.
// ELECTRON_RUN_AS_NODE also works in the packaged ASS executable.
const net = require('node:net');
const { Transform } = require('node:stream');
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid ASS port');
const socket = net.connect({ host: '127.0.0.1', port });
let header = Buffer.alloc(0), forwarded = false;
const request = new Transform({ transform(chunk, encoding, done) {
  if (forwarded) return done(null, chunk);
  header = Buffer.concat([header, chunk]);
  const end = header.indexOf('\r\n\r\n');
  if (end < 0) return done(header.length > 65536 ? Error('HTTP header too large') : null);
  const lines = header.subarray(0, end).toString('latin1').split('\r\n');
  // Each interop connection carries one HTTP request. Translate the Linux
  // loopback authority to the Windows listener without changing its checks.
  const mapped = lines.filter((line, index) => !index || !/^(host|connection):/i.test(line));
  const upgrading = lines.some(line => /^connection:.*\bupgrade\b/i.test(line));
  mapped.push('Host: 127.0.0.1:' + port, 'Connection: ' + (upgrading ? 'Upgrade' : 'close'), '', '');
  this.push(Buffer.from(mapped.join('\r\n'), 'latin1'));
  forwarded = true;
  done(null, header.subarray(end + 4));
  header = null;
} });
socket.once('connect', () => {
  process.stdout.write('ASS_READY\n');
  process.stdin.pipe(request).pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', () => { process.stderr.write('Windows ASS connection unavailable\n'); process.exitCode = 1; });
request.on('error', () => socket.destroy());
socket.once('close', () => process.stdin.destroy());
