"""ASS control and loopback transport in WSL. Never opens or edits sessions."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path.home() / '.local/share/ass'


def atomic(file, content):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.ass-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def digest(content):
    return hashlib.sha256((content or '').encode()).hexdigest()


def path_for(value):
    file = Path(value)
    if not file.is_absolute() or not file.is_relative_to(Path.home()):
        raise ValueError('Configuration path is outside the WSL home')
    for part in [file, *file.parents]:
        if part.is_symlink():
            raise ValueError('Configuration path contains a symlink')
    return file


def content(file):
    return file.read_text(encoding='utf-8') if file.exists() else None


def binary(name):
    direct = shutil.which(name)
    if direct:
        return direct
    candidates = list((Path.home() / '.nvm/versions/node').glob('*/bin/' + name))
    candidates += [Path.home() / '.local/bin' / name, Path.home() / '.npm-global/bin' / name]
    return str(next((p for p in sorted(candidates, reverse=True) if p.is_file()), ''))


def healthy(port):
    try:
        with socket.create_connection(('127.0.0.1', port), 1) as connection:
            connection.sendall(b'GET /__ass_wsl_health HTTP/1.0\r\n\r\n')
            return b'ASS_WSL_BRIDGE' in connection.recv(1024)
    except OSError:
        return False


async def copy(reader, writer):
    while True:
        data = await reader.read(65536)
        if not data:
            break
        writer.write(data)
        await writer.drain()


async def connection(reader, writer, root):
    child = None
    tasks = []
    try:
        first = await asyncio.wait_for(reader.readline(), 10)
        if first.startswith(b'GET /__ass_wsl_health '):
            writer.write(b'HTTP/1.0 200 OK\r\nContent-Length: 14\r\n\r\nASS_WSL_BRIDGE')
            await writer.drain()
            return
        config = json.loads((root / 'bridge-config.json').read_text())
        env = {**os.environ, 'ELECTRON_RUN_AS_NODE': '1'}
        shared = env.get('WSLENV', '').split(':')
        env['WSLENV'] = ':'.join([v for v in shared if v and v.split('/')[0] != 'ELECTRON_RUN_AS_NODE'] + ['ELECTRON_RUN_AS_NODE/w'])
        child = await asyncio.create_subprocess_exec(config['executable'], config['script'], str(config['port']),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=env)
        if await asyncio.wait_for(child.stdout.readline(), 10) != b'ASS_READY\n':
            raise ConnectionError('Windows ASS is unavailable')
        child.stdin.write(first)
        await child.stdin.drain()
        tasks = [asyncio.create_task(copy(reader, child.stdin)), asyncio.create_task(copy(child.stdout, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, ConnectionError, asyncio.TimeoutError, ValueError):
        if not writer.is_closing():
            writer.write(b'HTTP/1.0 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    finally:
        for task in tasks:
            task.cancel()
        if child:
            child.stdin.close()
            try:
                await asyncio.wait_for(child.wait(), 2)
            except asyncio.TimeoutError:
                child.kill()  # Only this connection's interop helper, never the ASS GUI.
                await child.wait()
        writer.close()
        await writer.wait_closed()


async def serve(root):
    server = await asyncio.start_server(lambda reader, writer: connection(reader, writer, root), '127.0.0.1', 0)
    atomic(root / 'bridge-state.json', json.dumps({'port': server.sockets[0].getsockname()[1], 'pid': os.getpid()}))
    async with server:
        await server.serve_forever()


def control(data):
    action = data['action']
    if action == 'inspect':
        home = str(Path.home())
        dirs = {key: os.environ.get(env) or home + suffix for key, env, suffix in [
            ('codex', 'CODEX_HOME', '/.codex'), ('claude', 'CLAUDE_CONFIG_DIR', '/.claude'), ('pi', 'PI_CODING_AGENT_DIR', '/.pi/agent')]}
        return {'home': home, 'dirs': dirs, 'binaries': {name: binary(name) for name in dirs}}
    if action == 'read':
        return {file: content(path_for(file)) for file in data['files']}
    if action == 'write':
        originals = {row['file']: content(path_for(row['file'])) for row in data['files']}
        for row in data['files']:
            if digest(originals[row['file']]) != row['beforeHash']:
                raise ValueError('WSL configuration changed during synchronization')
        written = []
        try:
            for row in data['files']:
                if row['after'] is None:
                    path_for(row['file']).unlink(missing_ok=True)
                else:
                    atomic(path_for(row['file']), row['after'])
                written.append(row['file'])
        except Exception:
            for file in reversed(written):
                if originals[file] is None:
                    path_for(file).unlink(missing_ok=True)
                else:
                    atomic(path_for(file), originals[file])
            raise
        return {'written': len(written)}
    if action == 'bridge':
        root = ROOT / str(data['config']['port'])
        root.mkdir(parents=True, exist_ok=True)
        atomic(root / 'wsl-agent.py', data['source'])
        atomic(root / 'bridge-config.json', json.dumps(data['config']))
        state_file = root / 'bridge-state.json'
        if state_file.exists():
            state = json.loads(state_file.read_text())
            if healthy(state['port']):
                return state
        subprocess.Popen([sys.executable, str(root / 'wsl-agent.py'), 'serve', str(root)], stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(60):
            time.sleep(.05)
            if state_file.exists():
                state = json.loads(state_file.read_text())
                if healthy(state['port']):
                    return state
        raise RuntimeError('WSL loopback bridge did not start')
    if action == 'probe':
        with socket.create_connection(('127.0.0.1', data['port']), 3) as connection:
            connection.sendall(b'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')
            first = connection.recv(1024).split(b'\r\n')[0].decode('ascii', 'replace')
        if '502' in first or not first.startswith('HTTP/'):
            raise RuntimeError('Windows ASS cannot be reached through the WSL bridge')
        return {'reachable': True}
    raise ValueError('Unknown WSL operation')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        asyncio.run(serve(Path(sys.argv[2])))
    else:
        try:
            print(json.dumps({'ok': True, 'value': control(json.load(sys.stdin))}))
        except Exception as error:
            print(json.dumps({'ok': False, 'error': str(error)}))
            sys.exit(1)
