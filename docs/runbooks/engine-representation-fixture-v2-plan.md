# Isolated Engine Fixture V2 Plan

Status: offline candidate for independent review only.  No second probe is released by this document or has been executed.  Production validation, controllers and runtime remain untouched.

## Basis And Exact Changes

The first reviewed fixture stopped after A creation returned a warning.  Read-only reconciliation established that its requested `MemorySwappiness=0` became null and its volume mount declaration omitted the optional false `ReadOnly` field.  Restoring only swappiness to zero in an in-memory inspect copy passed the original closed validator.  The original warning body was discarded, so its exact text and category remain unverified.  The released separate cleanup then removed that exact A/volume/RAM scope; independent readback confirmed all exact container names/ID and volume 404 and RAM absent (coordination receipt 637298754).

This new standalone fixture starts from the unchanged reviewed executor SHA256 `da431146b352cc047313624f04d2041073d7d093928308b6b6115217362f1b32`.  Its complete finite procedure and isolation rules follow the original plan SHA256 `ca0b792e8273ae04154774aa7f12adf09fe1f87deb525a883f4597ffc2e7d361`, with only these explicit candidate differences:

1. New nonce `8e4a92f7`, exact names/labels/RAM paths below, separate executor and separately hashed plan.  The previous nonce, created IDs and cleanup artifacts are historical and cannot be reused.
2. Require the fresh initial `/info` response to report `CgroupVersion="2"` in addition to the reviewed daemon-ID fingerprint.  Any other value fails before file creation or mutation.
3. Request and require the explicit JSON `HostConfig.MemorySwappiness=null`.  This expresses an unset per-container swappiness tuning value; missing, zero, negative, positive, Boolean and string values are refused by the fixture's closed validator.  The existing `Memory=67108864` and `MemorySwap=67108864` caps remain exact, as do CPU/PID limits, no-start behavior and every isolation gate.
4. Omit only the optional false `ReadOnly` member from the fixed `/data` volume declaration, matching the observed serialized declaration.  The validator still requires its effective value to be Boolean false, the exact named volume, `/data`, `NoCopy=true`, no subpath/driver override and no unknown nested options.  It accepts only omission or explicit false for that optional field; true or another type fails.  The bind remains explicitly read-only to the exact synthetic RAM file, with private propagation and no daemon-created source path.  No resolved-invariant comparison field is removed or normalized.
5. Point the executor's existing review fence to this separately hashed plan.  Transport, request/byte/deadline limits, closed host-access policy, warning rejection, reconstruction and exact cleanup are otherwise unchanged.

Upstream Moby represents swappiness as a nullable integer pointer and mount `ReadOnly` as a Boolean serialized with `omitempty`: [resource definitions](https://github.com/moby/moby/blob/master/api/types/container/hostconfig.go), [mount definitions](https://github.com/moby/moby/blob/master/api/types/mount/mount.go).  These current source definitions support the candidate representation; they do not prove its live acceptance on the reviewed daemon.  Actual acceptance and A/B equivalence remain unverified until a separate exact execution release and successful run.

## Fixed Resources And Preconditions

| Resource | Exact Name |
| --- | --- |
| Stopped A | `um1654-repr-01a1a250-8e4a92f7-a` |
| Stopped B | `um1654-repr-01a1a250-8e4a92f7-b` |
| Disposable tmpfs journal volume | `um1654-repr-01a1a250-8e4a92f7-journal` |
| Exclusive RAM directory | `/dev/shm/um1654-repr-01a1a250-8e4a92f7` |

Container labels are exactly task `UM-1654`, session `01a1a250-33bb-7a52-b3e9-32f1a80699a8`, nonce `8e4a92f7`, role `container`, under the original `com.simplewithus.fixture.*` keys.  The volume differs only in role `journal`.  Existing names, resources or RAM path must stop the run; this preparation does not claim that the new names are currently absent.

Retain the fixed local root-owned socket `/var/run/docker.sock`, fixed API `/v1.53`, and daemon-ID SHA256 `659e19e4b792e0ed00b136b7e91ad7ae1ea7decbf9e7930cdf1488d69b496565`.  Use only the already-cached nonproduction image ID `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`, immutable reference `python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`; freshly verify API/image/env-name set and absent resource names before mutation.  No mutable tag, pull, build, Docker context or credential/configuration helper is allowed.

## Finite Procedure And Safety Boundaries

Before any eventual run, verify the reviewed executor/plan bytes and no competing fixture writer through current coordination and bounded process checks.  Default mode performs zero Engine calls and zero writes.  Execution requires a separate exact parent release naming the new hashes, daemon and nonce.

The procedure remains: fingerprint/API/image/absence checks; exclusive private synthetic RAM file; one exact volume create and metadata verification; one stopped A create with no warning and exact full-ID inspect; deep-copy actual A Config/HostConfig into B, changing only Image to the immutable resolved ID; independently validate the entire B body at registration and immediately before wire send; one stopped B create with no warning and exact full-ID inspect; compare complete Config/HostConfig/Mounts/Image, normalizing only Config.Hostname and reference-versus-ID representation.  Require matching null swappiness and the full observed mount declarations in both projections.  Do not drop fields, coerce values or relax any production check.

Both containers remain unstarted, network `none`, `NetworkDisabled=true`, readonly root, UID/GID `10001:10001`, cap drop ALL, no-new-privileges, private IPC/cgroup and no host PID/UTS/user namespace.  No device, host-access field, executable/image/env override or unreviewed mount/source is accepted.  Runtime, resource limits, kernel masked/read-only paths, healthcheck NONE, restart no and synthetic fixed command remain as the original reviewed executor.  The only file bind is the exclusive 0600 synthetic RAM config inside the exclusive 0700 directory; the only volume is the exact labeled local-driver tmpfs with `type=tmpfs`, `device=tmpfs`, `o=size=1m,uid=10001,gid=10001`.

Each mutation must fingerprint `/info` on the same established pinned root-peer connection with reconnect disabled.  One absolute 15-second deadline covers connect, handshake, request and response; total headers/body are bounded to 1 MiB.  At most 30 wire requests (29 on confirmed path), three creates and confirmed-path cleanup; no retry, start, exec, stop, restart, rename, update, archive, image/network mutation or pruning route.  Any warning, unknown result, unexpected response, changed daemon/resource/file identity or unexplained field stops the run and preserves remaining resources/evidence for bounded read-only reconciliation and a new finite cleanup decision.

Only a completely confirmed comparison permits cleanup: re-read exact B then A IDs and require ownership/image/name/stopped state, delete those exact IDs with `v=false&force=false&link=false`, require 204 and exact ID/name 404; reverify exact volume labels/driver/options and both container absences, delete only that volume with `force=false`, require 204 and GET 404; verify original RAM inode/owner/mode/content identities before removing only its exact files and empty original directory.  No forced, recursive, broad or retry cleanup is allowed.

Success would establish only this synthetic configuration's behavior on the exact cached image/daemon/API.  It would not establish production image/host-network equivalence, journal continuity, source-map/secret custody, receiver delivery, billing or authority to activate production.  Temporary daemon metadata/events are accepted fixture effects; cleanup does not erase daemon history.  No live production action or second probe is authorized here.
