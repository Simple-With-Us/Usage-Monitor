#!/usr/bin/env python3
"""Supplement the existing VPS snapshot without reading arguments or credentials.

Run after the existing watch finishes, under the same scheduler lock.  Directory
failures omit that measurement; they never become a fictitious zero size.
"""
import argparse
import datetime
import re
import json
import os
import pwd
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

TOOLS = (
    ('claude', 'Claude Code', ('claude',)),
    ('codex', 'Codex', ('codex',)),
    ('muse', 'Muse', ('muse',)),
    # The seat's own launcher is named minimax-code; mcode is the installed
    # command name.  Both are the same tool, and matching only one of them
    # made a running seat read as unknown.
    ('minimax', 'MiniMax Code', ('mcode', 'minimax-code')),
    ('fleet-cli', 'Fleet CLI', ('agent-sync', 'board')),
    ('fleet-listener', 'Fleet Listener', ('agent-sync-listener',)),
    ('recall', 'Fleet Recall', ('recall',)),
    ('shellular', 'Shellular', ('shellular',)),
    ('docker', 'Docker', ('dockerd',)),
    ('postgres', 'PostgreSQL', ('postgres',)),
    ('redis', 'Redis', ('redis-server',)),
)

# Tools whose only presence on this host is a container.  Inside the container
# the process identity is an interpreter, so the container name is the honest
# identity and the process identity can never prove it.
CONTAINER_TOOLS = {
    'recall-api': 'recall',
    'fleet-recall': 'recall',
    # The listener runs as a Coolify workload here, not as a systemd unit, so
    # the workload is the only identity that can answer for it.  Its container
    # is named after the deployment, so the workload's own name is matched too.
    'agent-sync-listener': 'fleet-listener',
}

# Tools that run under an interpreter.  For these, "not seen in the process
# table" cannot be read as "not running", because the process would be named
# node or python rather than after the tool.
INTERPRETED_TOOLS = {'claude', 'muse', 'minimax', 'fleet-cli', 'fleet-listener', 'recall'}

DIRECTORIES = ('Code', 'apps/lanes', '.claude', '.codex', '.config/muse', '.minimax', '.minimax-code', '.npm', '.cache')

# How many processes the snapshot carries, and how many of each owner group.
PROCESS_LIMIT = 30
OWNER_GROUPS = ('root', 'jay', 'container')


def process_inventory(proc=Path('/proc')):
    """Read executable names only; permission errors make negative results unknown."""
    names = []
    complete = True
    try:
        entries = list(proc.iterdir())
    except OSError:
        return [], False
    for entry in entries:
        if not entry.name.isdigit():
            continue
        if int(entry.name) in {os.getpid(), os.getppid()}:
            continue  # The collector and its launcher are not watched tools.
        try:
            name = (entry / 'comm').read_text().strip()
            # Kernel comm truncates names.  The symlink is executable identity only.
            try:
                executable = Path(os.readlink(entry / 'exe')).name
            except FileNotFoundError:
                executable = name
            names.append({name, executable})
        except FileNotFoundError:
            continue  # A process exiting during enumeration is normal.
        except OSError:
            complete = False
    return names, complete


def installed_command(command, home=None):
    home = Path.home() if home is None else home
    candidates = [home / '.local/bin' / command, home / '.minimax-code/bin' / command,
                  home / '.cargo/bin' / command, home / '.codex/bin' / command]
    if command == 'shellular' and (home / 'apps/shellular-runtime').is_dir():
        return True
    return any(path.is_file() and os.access(path, os.X_OK) for path in candidates)


def container_inventory(run=subprocess.run):
    """The identities of the running containers, or None when Docker cannot answer.

    A container is named two ways: after its deployment, which is a uuid on
    this host, and after the Coolify workload it belongs to, which is the name
    the owner knows.  Both are returned, so a tool can be recognised by
    whichever one it actually carries.
    """
    try:
        listing = run(['docker', 'ps', '--format', '{{.ID}}'],
                      capture_output=True, text=True, timeout=5, check=False)
        if listing.returncode != 0:
            return None
        ids = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
        if not ids:
            return set()
        detail = run(['docker', 'inspect'] + ids, capture_output=True, text=True, timeout=15, check=False)
        if detail.returncode != 0:
            return None
        inspected = json.loads(detail.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    containers = []
    for entry in inspected if isinstance(inspected, list) else []:
        container = (entry.get('Name') or '').lstrip('/')
        labels = (entry.get('Config') or {}).get('Labels') or {}
        names = [container] if container else []
        for key in ('coolify.name', 'coolify.resourceName', 'coolify.serviceName'):
            value = labels.get(key)
            if value and value not in names:
                names.append(value)
        if names:
            containers.append({'container': container, 'names': names})
    return containers


def container_tool_counts(containers):
    """How many containers belong to each tool.

    A container is counted once, even when it answers to more than one name:
    the recall workload is called both after its container and after the
    workload it is, and it is still one workload.
    """
    counts = {}
    if not containers:
        return counts
    for entry in containers:
        if isinstance(entry, dict):
            names = entry.get('names') or []
        else:
            names = [entry]
        for name in names:
            for prefix, ident in CONTAINER_TOOLS.items():
                if name == prefix or name.startswith(prefix + '-') or name.startswith(prefix):
                    counts[ident] = counts.get(ident, 0) + 1
                    break
            else:
                continue
            break
    return counts


def tool_statuses(inventory, complete, which=shutil.which, installed=installed_command, containers=None):
    rows = []
    # Interpreted CLIs cannot be identified safely from executable identity alone.
    interpreted = any(names & {'node', 'nodejs', 'python', 'python3', 'bash', 'sh'} for names in inventory)
    counts = container_tool_counts(containers)
    for ident, label, commands in TOOLS:
        count = sum(bool(names.intersection(commands)) for names in inventory)
        is_installed = any(which(command) is not None or installed(command) for command in commands)
        if count:
            state = 'running'
            reason = f'{count} process' + ('' if count == 1 else 'es')
        elif counts.get(ident):
            state = 'running'
            count = counts[ident]
            reason = f'{count} container' + ('' if count == 1 else 's')
        elif not is_installed:
            # A tool that is not on this host cannot be running here, whatever
            # else is.  This answer does not depend on the process list.
            state = 'absent'
            reason = 'not installed on this host'
        elif not complete:
            state = 'unknown'
            reason = 'the process list could not be read completely'
        elif interpreted and ident in INTERPRETED_TOOLS:
            state = 'unknown'
            reason = 'runs under an interpreter; not provable from process identity'
        else:
            state = 'stopped'
            reason = 'installed; no matching process'
        rows.append(dict(id=ident, name=label, state=state, count=count, reason=reason))
    return rows


# Named service metadata can identify interpreted daemons without inspecting argv.
SERVICE_UNITS = {
    'fleet-listener': 'agent-sync-listener.service',
    'recall': 'fleet-recall.service',
    'shellular': 'shellular.service',
    # Claude Code reaches this host as a named service; its unit answers the
    # question the process identity cannot.
    'claude': 'claude-remote-control.service',
}


def service_state(unit, run=subprocess.run):
    try:
        result = run(['systemctl', 'show', unit, '--property=LoadState,ActiveState', '--no-pager'],
                     capture_output=True, text=True, timeout=2, check=False)
        values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if result.returncode != 0 or values.get('LoadState') != 'loaded':
            return None
        active = values.get('ActiveState')
        if active == 'active':
            return 'running'
        if active in {'inactive', 'failed'}:
            return 'stopped'
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def shellular_state(home, run=subprocess.run, proc=Path('/proc')):
    """Read the manager's filtered identity helper, never PM2 environment or argv."""
    helper = home / 'apps/shellular-runtime/bin/status-json'
    expected = str(home / 'apps/shellular-runtime/lib/node_modules/shellular/dist/main.js')
    try:
        result = run([str(helper)], capture_output=True, text=True, timeout=3, check=False)
        if result.returncode != 0 or len(result.stdout) > 4096:
            return 'unknown'
        identity = json.loads(result.stdout)
        if not isinstance(identity, dict) or identity.get('name') != 'shellular' or identity.get('execpath') != expected:
            return 'unknown'
        status = identity.get('status')
        if status == 'online':
            pid = identity.get('pid')
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 and (proc / str(pid) / 'exe').exists():
                return 'running'
            return 'unknown'
        if status in {'stopped', 'offline', 'errored'}:
            return 'stopped'
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return 'unknown'


def directory_bytes(path, run=subprocess.run):
    try:
        if not path.is_dir():
            return None
        result = run(['du', '-sx', '--block-size=1', '--', str(path)],
                     capture_output=True, text=True, timeout=8, check=False)
        if result.returncode != 0:
            return None
        value = int(result.stdout.split()[0])
        return value if value >= 0 else None
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        return None


def _process_ticks(proc):
    """pid -> (name, ticks, start_time) from /proc identity only: never argv."""
    rows = {}
    try:
        entries = list(proc.iterdir())
    except OSError:
        return rows
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / 'stat').read_text()
            name = (entry / 'comm').read_text().strip()
        except OSError:
            continue  # A process exiting during enumeration is normal.
        try:
            # stat is "pid (comm) state ppid ..."; utime is field 14 and stime
            # field 15, so they sit at index 11 and 12 after the state field.
            tail = raw[raw.rindex(')') + 2:].split()
            ticks = int(tail[11]) + int(tail[12])
            start_time = int(tail[19])
        except (ValueError, IndexError):
            continue
        rows[int(entry.name)] = (name, ticks, start_time)
    return rows


def _owner_of(pid, proc=Path('/proc')):
    try:
        uid = (proc / str(pid)).stat().st_uid
    except OSError:
        return None
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def _resident_bytes(pid, proc=Path('/proc')):
    try:
        fields = (proc / str(pid) / 'statm').read_text().split()
        return int(fields[1]) * os.sysconf('SC_PAGE_SIZE')
    except (OSError, IndexError, ValueError):
        return None


def container_identities(run=subprocess.run):
    """Container id -> container name for the running containers."""
    identities = {}
    try:
        result = run(['docker', 'ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'],
                     capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return identities
    if result.returncode != 0:
        return identities
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            identities[parts[0]] = parts[1]
    return identities


def _container_of(pid, identities, proc=Path('/proc')):
    if not identities:
        return None
    try:
        cgroup = (proc / str(pid) / 'cgroup').read_text()
    except OSError:
        return None
    for container_id, name in identities.items():
        if container_id in cgroup:
            return name
    return None


def top_processes(proc=Path('/proc'), limit=PROCESS_LIMIT, sleep=time.sleep, elapsed=1.0, run=subprocess.run):
    """The server's busiest processes, by CPU share of one core.

    The reading comes from executable identity and the kernel's own tick
    counters.  Command arguments, environment variables and credential files
    are never read, so a process that hides its work behind an interpreter is
    still named after its executable and never after its arguments.
    """
    first = _process_ticks(proc)
    sleep(elapsed)
    second = _process_ticks(proc)
    hz = os.sysconf('SC_CLK_TCK')
    identities = container_identities(run)
    rows = []
    for pid, (name, ticks, start_time) in second.items():
        before = first.get(pid)
        if before is None:
            continue  # The process started inside the window; its rate is unknown.
        delta = ticks - before[1]
        if delta < 0:
            continue
        container = _container_of(pid, identities, proc)
        rows.append(dict(
            pid=pid,
            name=name,
            # The start time is what makes the process identifiable: a pid on
            # its own can be reused, a pid with its start time cannot.
            start_time=start_time,
            owner=_owner_of(pid, proc),
            container=container,
            cpu_percent=round(100.0 * delta / (hz * elapsed), 2),
            memory_bytes=_resident_bytes(pid, proc),
        ))
    rows.sort(key=lambda row: (-row['cpu_percent'], row['pid']))
    return rows[:limit]


def _parse_bytes(text):
    """A memory reading like "535.1MiB" into bytes, or None when unreadable."""
    match = re.match(r'^\s*([0-9.]+)\s*([A-Za-z]+)\s*$', str(text))
    if match is None:
        return None
    factors = {'b': 1, 'kb': 1024, 'kib': 1024, 'mb': 1024 ** 2, 'mib': 1024 ** 2,
               'gb': 1024 ** 3, 'gib': 1024 ** 3, 'tb': 1024 ** 4, 'tib': 1024 ** 4}
    factor = factors.get(match.group(2).lower())
    if factor is None:
        return None
    try:
        return int(float(match.group(1)) * factor)
    except ValueError:
        return None


def coolify_resources(run=subprocess.run):
    """The Coolify workloads this host runs, from container identity only.

    Coolify's API needs a token, so the snapshot never touches one.  The
    container's own labels carry its name, type and uuid, and the container
    runtime carries its state, health and resource use.
    """
    try:
        listing = run(['docker', 'ps', '--format', '{{.ID}}'], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if listing.returncode != 0:
        return None
    ids = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
    if not ids:
        return []
    try:
        detail = run(['docker', 'inspect'] + ids, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if detail.returncode != 0:
        return None
    try:
        inspected = json.loads(detail.stdout)
    except ValueError:
        return None
    stats = {}
    try:
        stat_result = run(['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'],
                           capture_output=True, text=True, timeout=20, check=False)
        if stat_result.returncode == 0:
            for line in stat_result.stdout.splitlines():
                parts = line.split('\t')
                if len(parts) >= 2:
                    stats[parts[0]] = parts[1:]
    except (OSError, subprocess.TimeoutExpired):
        pass
    rows = []
    for entry in inspected if isinstance(inspected, list) else []:
        labels = (entry.get('Config') or {}).get('Labels') or {}
        if 'coolify.name' not in labels:
            continue  # Not a Coolify workload; the Mac reads containers elsewhere.
        container_name = (entry.get('Name') or '').lstrip('/')
        project = labels.get('coolify.projectName') or ''
        resource = labels.get('coolify.resourceName') or labels.get('coolify.serviceName') or ''
        name = ' / '.join(part for part in (project, resource) if part) or labels['coolify.name']
        state = (entry.get('State') or {})
        status = state.get('Status') or 'unknown'
        health = (state.get('Health') or {}).get('Status')
        if status == 'running':
            status = 'unhealthy' if health == 'unhealthy' else 'running'
        usage = stats.get(container_name, [])
        cpu = None
        if usage:
            try:
                cpu = float(str(usage[0]).replace('%', '').strip())
            except (IndexError, ValueError):
                cpu = None
        memory = None
        if len(usage) > 1:
            memory = _parse_bytes(str(usage[1]).split('/')[0])
        rows.append(dict(
            uuid=labels.get('coolify.applicationUuid') or labels.get('coolify.uuid') or labels['coolify.name'],
            name=name,
            type=labels.get('coolify.type') or 'standalone',
            status=status,
            cpu_percent=cpu,
            memory_bytes=memory,
            image=(entry.get('Config') or {}).get('Image') or '',
            started_at=state.get('StartedAt') or '',
        ))
    rows.sort(key=lambda row: (row['type'], row['name']))
    return rows


def supplement(snapshot, home, measure=directory_bytes, inventory=None, services=service_state, shellular=shellular_state, extra_volume=Path('/mnt/fleet-extra'), statvfs_func=os.statvfs, ismount_func=os.path.ismount, containers=None, processes=None, coolify=None, collect_live=False):
    result = dict(snapshot)
    devices = dict(snapshot.get('devices', {}))
    if extra_volume and ismount_func(str(extra_volume)):
        try:
            st = statvfs_func(str(extra_volume))
            free = st.f_bavail * st.f_frsize
            total = st.f_blocks * st.f_frsize
            if total > 0:
                total_gb = int(round(total / (1024**3)))
                if 'fleet_extra' not in devices and 'fleet-extra' not in devices:
                    devices['fleet_extra'] = {
                        'mount': str(extra_volume),
                        'free_bytes': free,
                        'note': f"{total_gb}GB disk: extra volume {extra_volume}"
                    }
        except OSError:
            pass
    result['devices'] = devices
    directories = {row['path']: row for row in snapshot.get('largest_dirs', [])}
    for relative in DIRECTORIES:
        path = home / relative
        directories.pop(str(path), None)
        size = measure(path)
        if size is not None:
            directories[str(path)] = dict(path=str(path), bytes=size)
    result['largest_dirs'] = list(directories.values())
    names, complete = process_inventory() if inventory is None else inventory
    if containers is None and collect_live:
        containers = container_inventory()
    rows = tool_statuses(names, complete, containers=containers)
    for row in rows:
        if row['id'] in SERVICE_UNITS and row['state'] != 'running':
            state = services(SERVICE_UNITS[row['id']])
            if state is not None:
                row['state'] = state
                row['count'] = 1 if state == 'running' else 0
                row['reason'] = f'{SERVICE_UNITS[row["id"]]} is {state}'
    for row in rows:
        if row['id'] == 'shellular':
            state = shellular(home)
            if state in {'running', 'stopped'} or row['state'] not in {'running', 'stopped'}:
                row['state'] = state
                row['count'] = 1 if state == 'running' else 0
                row['reason'] = f'shellular manager says {state}'
    result['tool_statuses'] = rows
    if collect_live:
        result['processes'] = top_processes() if processes is None else processes()
        result['coolify'] = coolify_resources() if coolify is None else coolify()
    elif processes is not None:
        result['processes'] = processes()
    elif coolify is not None:
        result['coolify'] = coolify()
    return result


def database_samples(snapshot, state):
    """Read only the three audited numeric size histories, never database contents."""
    try:
        source_time = datetime.datetime.fromisoformat(snapshot['generated_at'].replace('Z', '+00:00')).timestamp()
    except (KeyError, ValueError, TypeError):
        return []
    samples = []
    for key in ('st_app_db', 'ct_db', 'um_db'):
        if key not in snapshot.get('app_dbs', {}):
            continue
        try:
            path = state / (key + '.samples')
            if path.stat().st_size > 1_048_576:
                continue
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            if re.fullmatch(r'[0-9]+ [0-9]+', line) is None:
                continue
            timestamp, size = map(int, line.split())
            if source_time - 172800 <= timestamp <= source_time and size <= 9223372036854775807:
                samples.append(dict(path=key, bytes=size, sampled_at=timestamp))
    return sorted(samples, key=lambda row: row['sampled_at'])[-1800:]


def directory_samples(snapshot, state):
    """Own a bounded new directory-history file; leave legacy histories untouched."""
    try:
        timestamp = datetime.datetime.fromisoformat(snapshot['generated_at'].replace('Z', '+00:00')).timestamp()
    except (KeyError, ValueError, TypeError):
        return []
    path = state / 'hoghunter-directory-history.json'
    previous = {}
    try:
        if path.stat().st_size <= 1_048_576:
            previous = json.loads(path.read_text())
    except (OSError, ValueError):
        pass
    host = snapshot.get('host', '')
    rows = previous.get('samples', []) if isinstance(previous, dict) and previous.get('host') == host else []
    if not isinstance(rows, list):
        rows = []
    valid = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        when, size, name = row.get('sampled_at'), row.get('bytes'), row.get('path')
        if (isinstance(when, (int, float)) and isinstance(size, int) and size >= 0
                and isinstance(name, str) and len(name) <= 4096
                and timestamp - 172800 <= when <= timestamp):
            valid[(name, int(when // 900))] = row
    for directory in snapshot.get('largest_dirs', []):
        valid[(directory['path'], int(timestamp // 900))] = dict(
            path=directory['path'], bytes=directory['bytes'], sampled_at=timestamp)
    # Each path has at most 193 quarter-hour observations over the 48-hour window.
    rows = sorted(valid.values(), key=lambda row: row['sampled_at'])
    by_path = {}
    for row in rows:
        by_path.setdefault(row['path'], []).append(row)
    rows = [row for group in by_path.values() for row in group[-193:]][-6000:]
    atomic_write(path, dict(host=host, samples=rows))
    return rows


def atomic_write(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.vps-status-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output, separators=(',', ':'))
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--history', type=Path, default=Path('/root/.vps-storage-watch'))
    parser.add_argument('--home', type=Path, default=Path.home())
    args = parser.parse_args()
    original = json.loads(args.snapshot.read_text())
    # Prevent applying measurements to a snapshot published during the scan.
    output = supplement(original, args.home, collect_live=True)
    output['database_samples'] = database_samples(original, args.history)
    output['directory_samples'] = directory_samples(output, args.history)
    current = json.loads(args.snapshot.read_text())
    if current != original:
        raise SystemExit('Snapshot changed during collection; leaving it untouched.')
    atomic_write(args.snapshot, output)


if __name__ == '__main__':
    main()
