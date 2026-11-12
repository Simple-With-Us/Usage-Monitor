"""Local compare-before-replace coordination guard for two child-source settings."""

from __future__ import annotations

import hashlib
import os
import secrets
import shlex
import stat
from dataclasses import dataclass, field
from pathlib import Path


SOURCE = Path("/home/jay/.secrets/usage-monitor.env")
BACKUP_NAME = "usage-monitor.env.um1646-child-source.before"
MAX_SOURCE_BYTES = 4 * 1024 * 1024
DESIRED = {
    "OPENCODE_ADDITIONAL_DBS_JSON": (
        '["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"]'
    ),
    "BOTFLEET_WORKSPACES_DIRS": "/mnt/fleet-extra/apps/botfleet-server/data/workspaces",
}


class CASFailure(Exception):
    """A sanitized refusal; messages contain reason codes only."""


@dataclass(frozen=True)
class Snapshot:
    source_path: Path
    content: bytes = field(repr=False)
    sha256: str
    device: int
    inode: int
    mtime_ns: int
    size: int
    uid: int
    gid: int
    mode: int
    key_states: dict[str, str]


def _failure(reason: str) -> CASFailure:
    return CASFailure(reason)


def _stat_tuple(value: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
    return (
        value.st_dev, value.st_ino, value.st_mtime_ns, value.st_size,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode),
    )


def _read_fd(fd: int, max_bytes: int) -> bytes:
    pieces: list[bytes] = []
    remaining = max_bytes + 1
    while remaining:
        block = os.read(fd, min(64 * 1024, remaining))
        if not block:
            break
        pieces.append(block)
        remaining -= len(block)
    data = b"".join(pieces)
    if len(data) > max_bytes:
        raise _failure("source_too_large")
    return data


def _read_at(
    parent_fd: int,
    name: str,
    *,
    max_bytes: int,
    uid: int,
    gid: int | None = None,
    mode: int | None = None,
    owner_only: bool = True,
) -> tuple[bytes, os.stat_result]:
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        raise _failure("file_stat_failed") from None
    if not stat.S_ISREG(before.st_mode) or before.st_uid != uid:
        raise _failure("file_type_or_owner_invalid")
    if gid is not None and before.st_gid != gid:
        raise _failure("file_group_invalid")
    actual_mode = stat.S_IMODE(before.st_mode)
    if (owner_only and actual_mode & 0o077) or (mode is not None and actual_mode != mode):
        raise _failure("file_mode_invalid")
    if before.st_size < 0 or before.st_size > max_bytes:
        raise _failure("source_too_large")

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(name, flags, dir_fd=parent_fd)
    except OSError:
        raise _failure("file_open_failed") from None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode) or _stat_tuple(opened) != _stat_tuple(before):
            raise _failure("file_changed_during_open")
        data = _read_fd(fd, max_bytes)
        after_fd = os.fstat(fd)
        try:
            after_path = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except OSError:
            raise _failure("file_changed_during_read") from None
        if (_stat_tuple(after_fd) != _stat_tuple(before)
                or _stat_tuple(after_path) != _stat_tuple(before)
                or len(data) != before.st_size):
            raise _failure("file_changed_during_read")
        return data, before
    finally:
        os.close(fd)


class ChildConfigLocalCAS:
    """Read and append only the two approved settings with repeated CAS checks."""

    def __init__(self, source_path: os.PathLike[str] | str = SOURCE) -> None:
        self.source_path = Path(source_path).absolute()
        if self.source_path.name != "usage-monitor.env":
            raise _failure("unexpected_source_name")

    def _open_parent(self) -> int:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            return os.open(self.source_path.parent, flags)
        except OSError:
            raise _failure("parent_open_failed") from None

    def _parse_states(self, content: bytes) -> dict[str, str]:
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            raise _failure("source_encoding_invalid") from None
        found: dict[str, str] = {}
        for line in text.splitlines():
            try:
                tokens = shlex.split(line, comments=True, posix=True)
            except ValueError:
                if any(key in line for key in DESIRED):
                    raise _failure("target_line_invalid") from None
                continue
            target_tokens = [
                token for token in tokens
                if token in DESIRED or token.partition("=")[0] in DESIRED
            ]
            if not target_tokens:
                continue
            exported = len(tokens) == 2 and tokens[0] == "export"
            if ((len(tokens) != 1 and not exported) or len(target_tokens) != 1
                    or "=" not in target_tokens[0]):
                raise _failure("target_assignment_ambiguous")
            key, value = target_tokens[0].split("=", 1)
            if key in found:
                raise _failure("target_assignment_duplicate")
            if value != DESIRED[key]:
                raise _failure("target_assignment_conflict")
            found[key] = value
        return {key: "equal" if key in found else "absent" for key in DESIRED}

    def snapshot(self) -> Snapshot:
        try:
            parent_fd = self._open_parent()
            try:
                data, info = _read_at(
                    parent_fd, self.source_path.name, max_bytes=MAX_SOURCE_BYTES,
                    uid=os.getuid(), owner_only=True,
                )
            finally:
                os.close(parent_fd)
        except CASFailure:
            raise
        except OSError:
            raise _failure("filesystem_operation_failed") from None
        states = self._parse_states(data)
        return Snapshot(
            source_path=self.source_path,
            content=data,
            sha256=hashlib.sha256(data).hexdigest(),
            device=info.st_dev,
            inode=info.st_ino,
            mtime_ns=info.st_mtime_ns,
            size=info.st_size,
            uid=info.st_uid,
            gid=info.st_gid,
            mode=stat.S_IMODE(info.st_mode),
            key_states=states,
        )

    def safePlan(self, snapshot: Snapshot) -> dict[str, object]:
        self._validate_snapshot_identity(snapshot)
        return {
            "sourceSha256": snapshot.sha256,
            "ownerUid": snapshot.uid,
            "ownerGid": snapshot.gid,
            "mode": f"{snapshot.mode:04o}",
            "keys": dict(snapshot.key_states),
            "desiredValueSha256": {
                key: hashlib.sha256(value.encode("utf-8")).hexdigest()
                for key, value in DESIRED.items()
            },
        }

    def _validate_snapshot_identity(self, snapshot: Snapshot) -> None:
        if not isinstance(snapshot, Snapshot) or snapshot.source_path != self.source_path:
            raise _failure("snapshot_source_mismatch")
        if snapshot.uid != os.getuid() or snapshot.mode & 0o077:
            raise _failure("snapshot_owner_or_mode_invalid")
        if hashlib.sha256(snapshot.content).hexdigest() != snapshot.sha256:
            raise _failure("snapshot_hash_invalid")
        if self._parse_states(snapshot.content) != snapshot.key_states:
            raise _failure("snapshot_key_state_invalid")

    def _matches_snapshot(self, parent_fd: int, snapshot: Snapshot) -> bool:
        current, info = _read_at(
            parent_fd, self.source_path.name, max_bytes=MAX_SOURCE_BYTES,
            uid=os.getuid(), owner_only=True,
        )
        return (
            hashlib.sha256(current).hexdigest() == snapshot.sha256
            and current == snapshot.content
            and info.st_dev == snapshot.device
            and info.st_ino == snapshot.inode
            and info.st_mtime_ns == snapshot.mtime_ns
            and info.st_size == snapshot.size
            and info.st_uid == snapshot.uid
            and info.st_gid == snapshot.gid
            and stat.S_IMODE(info.st_mode) == snapshot.mode
        )

    def _verify_backup(self, parent_fd: int, snapshot: Snapshot) -> bool:
        try:
            backup, info = _read_at(
                parent_fd, BACKUP_NAME, max_bytes=MAX_SOURCE_BYTES,
                uid=snapshot.uid, gid=snapshot.gid, mode=0o600,
            )
        except CASFailure as error:
            if str(error) == "file_stat_failed":
                return False
            raise
        if backup != snapshot.content:
            raise _failure("backup_mismatch")
        return True

    def prepare_backup(self, snapshot: Snapshot) -> dict[str, object]:
        self._validate_snapshot_identity(snapshot)
        parent_fd = self._open_parent()
        try:
            if not self._matches_snapshot(parent_fd, snapshot):
                raise _failure("source_compare_and_swap_failed")
            if self._verify_backup(parent_fd, snapshot):
                return {"backup": "verified", "sha256": snapshot.sha256}
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            try:
                fd = os.open(BACKUP_NAME, flags, 0o600, dir_fd=parent_fd)
            except OSError:
                raise _failure("backup_create_failed") from None
            try:
                os.fchown(fd, snapshot.uid, snapshot.gid)
                os.fchmod(fd, 0o600)
                _write_all(fd, snapshot.content)
                os.fsync(fd)
                complete = os.fstat(fd)
                if (not stat.S_ISREG(complete.st_mode) or complete.st_uid != snapshot.uid
                        or complete.st_gid != snapshot.gid or stat.S_IMODE(complete.st_mode) != 0o600
                        or complete.st_size != snapshot.size):
                    raise _failure("backup_metadata_invalid")
            except Exception:
                os.close(fd)
                raise
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass
            os.fsync(parent_fd)
            backup, info = _read_at(
                parent_fd, BACKUP_NAME, max_bytes=MAX_SOURCE_BYTES,
                uid=snapshot.uid, gid=snapshot.gid, mode=0o600,
            )
            if backup != snapshot.content or info.st_size != snapshot.size:
                raise _failure("backup_readback_mismatch")
            return {"backup": "created_and_verified", "sha256": snapshot.sha256}
        except CASFailure:
            raise
        except OSError:
            raise _failure("filesystem_operation_failed") from None
        finally:
            os.close(parent_fd)

    def apply_local(self, snapshot: Snapshot) -> dict[str, object]:
        self._validate_snapshot_identity(snapshot)
        parent_fd = self._open_parent()
        temp_name: str | None = None
        temp_identity: tuple[int, int] | None = None
        try:
            if not self._matches_snapshot(parent_fd, snapshot):
                raise _failure("source_compare_and_swap_failed")
            additions = [
                f"{key}={shlex.quote(DESIRED[key])}".encode("utf-8")
                for key, state in snapshot.key_states.items() if state == "absent"
            ]
            if not additions:
                return {"status": "already_equal", "sha256": snapshot.sha256}
            if not self._verify_backup(parent_fd, snapshot):
                raise _failure("backup_required")
            prefix = b"" if not snapshot.content or snapshot.content.endswith(b"\n") else b"\n"
            updated = snapshot.content + prefix + b"\n".join(additions) + b"\n"
            temp_name = f".{self.source_path.name}.um1646-{secrets.token_hex(12)}.tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            try:
                fd = os.open(temp_name, flags, snapshot.mode, dir_fd=parent_fd)
            except OSError:
                raise _failure("temp_create_failed") from None
            info = os.fstat(fd)
            temp_identity = (info.st_dev, info.st_ino)
            try:
                os.fchown(fd, snapshot.uid, snapshot.gid)
                os.fchmod(fd, snapshot.mode)
                _write_all(fd, updated)
                os.fsync(fd)
                staged = os.fstat(fd)
                if (not stat.S_ISREG(staged.st_mode) or staged.st_uid != snapshot.uid
                        or staged.st_gid != snapshot.gid or stat.S_IMODE(staged.st_mode) != snapshot.mode
                        or staged.st_size != len(updated)):
                    raise _failure("temp_metadata_invalid")
            finally:
                os.close(fd)

            if not self._matches_snapshot(parent_fd, snapshot):
                raise _failure("source_compare_and_swap_failed")
            os.replace(temp_name, self.source_path.name,
                       src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temp_name = None
            os.fsync(parent_fd)
            readback, readback_info = _read_at(
                parent_fd, self.source_path.name, max_bytes=MAX_SOURCE_BYTES,
                uid=snapshot.uid, gid=snapshot.gid, mode=snapshot.mode,
            )
            if readback != updated or readback_info.st_size != len(updated):
                raise _failure("source_readback_mismatch")
            states = self._parse_states(readback)
            if any(state != "equal" for state in states.values()):
                raise _failure("source_readback_keys_invalid")
            return {"status": "applied_and_verified", "sha256": hashlib.sha256(updated).hexdigest()}
        except CASFailure:
            raise
        except OSError:
            raise _failure("filesystem_operation_failed") from None
        finally:
            if temp_name is not None and temp_identity is not None:
                _unlink_owned(parent_fd, temp_name, *temp_identity)
            os.close(parent_fd)


def _write_all(fd: int, content: bytes) -> None:
    view = memoryview(content)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise _failure("file_write_failed")
        view = view[written:]


def _unlink_owned(parent_fd: int, name: str, device: int, inode: int) -> None:
    try:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if current.st_dev == device and current.st_ino == inode:
            os.unlink(name, dir_fd=parent_fd)
    except OSError:
        pass
