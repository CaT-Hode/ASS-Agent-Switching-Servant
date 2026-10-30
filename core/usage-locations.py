"""Read only CLI location metadata in the current WSL distribution."""
import json
import os
from pathlib import Path
import subprocess

DEFAULTS = {'codex': ('CODEX_HOME', '.codex'), 'claude': ('CLAUDE_CONFIG_DIR', '.claude'),
            'pi': ('PI_CODING_AGENT_DIR', '.pi/agent')}
roots = set()
projects = set()
homes = {str(Path.home())}
partial = False


def locations(home, env, client=None, cwd=None):
    homes.add(home)
    def resolve(value):
        if value == '~' or value.startswith('~/'):
            value = home + value[1:]
        directory = Path(value)
        return str(directory if directory.is_absolute() else Path(cwd or home) / directory)
    for name, (key, suffix) in DEFAULTS.items():
        if client and client != name:
            continue
        roots.add((name, str(Path(home) / suffix), False))
        if env.get(key):
            roots.add((name, resolve(env[key]), False))
        if name == 'pi' and env.get('PI_CODING_AGENT_SESSION_DIR'):
            roots.add((name, resolve(env['PI_CODING_AGENT_SESSION_DIR']), True))


def project(cwd, home):
    directory = Path(cwd)
    if not directory.is_absolute() or directory == Path(home):
        return
    for parent in [directory, *directory.parents]:
        if (parent / '.git').exists():
            projects.add(str(parent))
            return
    projects.add(str(directory))


locations(str(Path.home()), os.environ)
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        argv = (process / 'cmdline').read_bytes().split(b'\0')
        client = next((name for name in DEFAULTS if any(
            Path(value.decode(errors='replace')).name == name or
            (b'/claude-code/' in value if name == 'claude' else
             b'/pi-coding-agent/' in value if name == 'pi' else b'/@openai/codex/' in value)
            for value in argv[:2])), None)
        if not client:
            continue
        env = dict(value.decode(errors='replace').split('=', 1)
                   for value in (process / 'environ').read_bytes().split(b'\0') if b'=' in value)
        home = env.get('HOME', str(Path.home()))
        cwd = os.readlink(process / 'cwd')
        locations(home, env, client, cwd)
        project(cwd, home)
    except (OSError, ValueError):
        continue

for client, directory, _ in sorted(roots):
    if client != 'codex':
        continue
    try:
        file = Path(directory) / '.codex-global-state.json'
        if file.stat().st_size > 16 * 1024 ** 2:
            continue
        state = json.loads(file.read_text(encoding='utf-8'))
        for entry in state.get('local-projects', {}).values():
            projects.update(value for value in entry.get('rootPaths', []) if Path(value).is_absolute())
    except (OSError, ValueError):
        pass


def windows(value):
    return subprocess.run(['wslpath', '-w', value], check=True, capture_output=True,
                          text=True, timeout=3).stdout.strip()


output_roots = []
for client, directory, session_dir in sorted(roots):
    if not Path(directory).is_absolute():
        continue
    try:
        output_roots.append({'client': client, 'dir': windows(directory), 'sessionDir': session_dir})
    except (OSError, subprocess.SubprocessError):
        partial = True
output_projects = []
for directory in sorted(projects):
    try:
        output_projects.append(windows(directory))
    except (OSError, subprocess.SubprocessError):
        partial = True
output_homes = []
for directory in sorted(homes):
    try:
        output_homes.append(windows(directory))
    except (OSError, subprocess.SubprocessError):
        partial = True
print(json.dumps({'roots': output_roots, 'projects': output_projects, 'homes': output_homes, 'partial': partial}))
