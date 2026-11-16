# Isolated Engine Representation Fixture Plan

Status: prepared for parent review; nothing in this plan has been executed.  This is a finite synthetic create/inspect probe, not hub activation or a production lifecycle test.

## Authority And Coordination

The parent authorized investigation and preparation, then explicitly accepted reversible Docker daemon metadata for a temporary fixture.  Execution remains unreleased.  The controller worker retains its production-controller files and manifests; this worker owns only the fixture plan in its separate lane.  Coordination receipt: 637287924 in the existing UM-1654 topic.  CODEX identity was freshly verified; current Policy was paginated through 637233351 with no later messages.  BF-2624 was opened and read as the relevant shared-host isolation incident: no fuzzy production-container selection, credential helper, container exec or copied host configuration is permitted.

Any later release must name the reviewed executor bytes, this exact plan, image, names, API routes and cleanup behavior.  No new credential, account, grant, daemon, listener, Docker context, network, image pull or production setting is involved.  Only assigned CODEX routes may publish any resulting source.

## Verified Read-Only Prerequisites

- Existing local Engine: version `29.7.2`, API `1.55`, Linux x86_64, overlayfs storage.  The proposed fixed protocol is `/v1.53` and must still be checked against the Engine's minimum/maximum before execution.
- Already-cached image ID: `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`.
- Already-cached immutable reference: `python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea` (`python:3.12-slim` currently resolves to it).  Execution must use the immutable reference/ID, never the mutable tag.
- Image environment NAMES only: `PATH`, `LANG`, `GPG_KEY`, `PYTHON_VERSION`, `PYTHON_SHA256`.  No environment value or credential was read.  The create body overrides those names explicitly as described below.
- Read-only Docker queries succeeded.  No container or volume has been created, inspected, stopped, started, removed or altered for this probe.

## Exact Proposed Resources

Use one fixed nonce for this reviewed run: `6bd2a7ec`.  Refuse reuse or collision; a new nonce requires a new reviewed plan.

| Resource | Exact Name |
| --- | --- |
| Stopped source container A | `um1654-repr-01a1a250-6bd2a7ec-a` |
| Stopped reconstructed container B | `um1654-repr-01a1a250-6bd2a7ec-b` |
| Disposable journal volume | `um1654-repr-01a1a250-6bd2a7ec-journal` |
| RAM-backed host fixture directory | `/dev/shm/um1654-repr-01a1a250-6bd2a7ec` |

Both containers have identical labels: `com.simplewithus.fixture.task=UM-1654`, `com.simplewithus.fixture.session=01a1a250-33bb-7a52-b3e9-32f1a80699a8`, `com.simplewithus.fixture.nonce=6bd2a7ec`, and `com.simplewithus.fixture.role=container`.  The volume uses the same first three labels and `role=journal`.  Do not set any Coolify or Compose labels.  No production names, IDs, image, environment, configuration, secrets or volumes are inputs.

The volume uses the existing local driver with `type=tmpfs`, `device=tmpfs` and `o=size=1m,uid=10001,gid=10001`.  It must not be an existing volume.  Its daemon metadata and empty mountpoint are temporary persistent effects until cleanup; no container will start or mount it.  The RAM fixture directory is exclusively created with owner mode `0700`; `config.json` is an exclusively created owner `0600` file containing only `{"fixture":"UM-1654 representation probe"}`.  No host checkout, Docker socket, home, credential directory or production configuration is mounted.

## Proposed Container A Configuration

The reviewed executor must construct a fixed synthetic request rather than copying any live container.  Use the immutable cached reference above as `Image`; `User=10001:10001`; explicit `Entrypoint=["/usr/local/bin/python3"]`; `Cmd=["-c","raise SystemExit(97)"]`; `WorkingDir=/`; `Healthcheck.Test=["NONE"]`; `NetworkDisabled=true`; `Domainname=""`; `StopSignal=SIGTERM`; `StopTimeout=1`; no stdin, TTY or published/exposed ports.  A is created stopped, and no command or healthcheck is ever executed.

Explicit environment is only `PATH=/usr/local/bin:/usr/bin:/bin`, `LANG=C.UTF-8`, `GPG_KEY=`, `PYTHON_VERSION=`, `PYTHON_SHA256=` and `FIXTURE_MARKER=synthetic-um1654`.  This overrides the cached image's public defaults without reading or reusing their values.  Any unexpected environment name or nonmatching synthetic value in A's inspect is a stop condition before B creation.

Set `HostConfig.NetworkMode=none`, `ReadonlyRootfs=true`, `Privileged=false`, `RestartPolicy.Name=no`, `AutoRemove=false`, `CapDrop=["ALL"]`, `SecurityOpt=["no-new-privileges:true"]`, `Memory=67108864`, `MemorySwap=67108864`, `MemorySwappiness=0`, `NanoCpus=100000000`, `PidsLimit=16`, `LogConfig.Type=none`, `IpcMode=private`, `PidMode=""`, `UTSMode=""`, `UsernsMode=""` and `CgroupnsMode=private`, with no host namespace sharing.  Require empty `CgroupParent`, `Cgroup`, `ContainerIDFile`, `VolumeDriver` and `Isolation`; `Runtime=runc`; `Init=false`; `PublishAllPorts=false`; `OomKillDisable=false`; `OomScoreAdj=0`; `ShmSize=1048576`.  Include a 1 MiB `/tmp` tmpfs with `rw,noexec,nosuid` options.  No device mapping/request/cgroup rule, extra group, inherited volume, custom runtime, OCI annotation, sysctl/storage option, extra host, link or Docker socket is allowed.

Config and HostConfig are closed policies covering the official API 1.53 fields; an unknown field is refused before forwarding, even if apparently neutral.  Require the explicit masked/read-only kernel path lists in the executor.  Remaining approved resource defaults must be typed zero, CPU-affinity strings empty, and device/DNS/group/link/ulimit/volume-from arrays and annotation/storage/sysctl maps absent or empty.  Console size is only `[0,0]`.  Healthcheck timing defaults are only typed zero, with no test except `NONE`; image volume hints may name only the already-declared fixture targets with empty options.  These rules apply to A's inspect, the complete reconstructed B create body before registration, and again immediately before transport sends that body.  Do not treat the old selected-field check or a payload hash as a scope validator.

Declare the disposable named volume at `/data` read-write with `VolumeOptions.NoCopy=true`, no subpath or driver override, and the synthetic RAM file at `/run/fixture/config.json` read-only using explicit `HostConfig.Mounts`.  Require bind propagation `rprivate`, `CreateMountpoint=false` and no recursive-access overrides.  Unknown nested mount options are refused.  No bind source is created by the daemon: the exclusive RAM file must exist and match the reviewed ownership before the create request.

## Finite Procedure And Route Allowlist

Use the fixed local `/var/run/docker.sock` and `/v1.53` directly, with root-owned socket validation, root peer credentials and a freshly reviewed SHA256 of the raw UTF-8 daemon ID; ignore Docker host/context/proxy environment.  Before each mutation, read and verify `/info` on the same established Unix connection that will carry that mutation.  Pin the socket object/descriptor/peer, disable HTTP auto-reconnect, and refuse a closing or changed connection before sending; replacing the socket path cannot redirect that established stream.  A separate fingerprint connection is insufficient.

Bound each complete wire response, including headers, to 1 MiB.  One absolute 15-second deadline covers connect/send/header/body and, for a mutation, its same-connection `/info` handshake plus mutation.  Recompute remaining time at each underlying recv/send and buffered header readline; incremental header bytes must not reset the deadline.  Stop on malformed replies, warnings or unexpected status.  Maximum: two container creates, one volume create, no starts, no retries, and 30 total Engine requests including all fingerprint handshakes, cleanup and readback (29 on the confirmed fixture path).  No background polling is installed.

1. Read `GET /info`, `/version` and the exact immutable cached image's `/images/{reference}/json`; verify daemon/API/image identity and the approved image-environment name set.  Read only the two exact proposed container names and exact volume name to confirm all are absent; any existing object stops the probe without alteration.
2. Create the synthetic RAM fixture files, then `POST /volumes/create` once with the exact name/labels/options.  Require HTTP 201 and independently inspect that exact volume to verify its labels, local driver and options.  Do not read volume contents.
3. `POST /containers/create?name=<A>` once.  Require HTTP 201, no warnings and a new full 64-hex ID.  `GET /containers/{A-id}/json`; require that exact name, image ID, labels, `State.Running=false`, network `none` and every synthetic isolation/env/mount field.  Do not inspect any other container.
4. Record A's actual resolved Config/HostConfig/Mounts in RAM.  Construct B from deep copies of A.Config and A.HostConfig, replacing only `Config.Image` with A's immutable `Image` ID.  Use B's exact distinct name and the same fixture labels.  Before sending, independently verify the complete request remains synthetic and scoped to the exact fixture volume/bind paths; no live planner guard is relaxed or enabled.
5. `POST /containers/create?name=<B>` once; require HTTP 201, no warnings and a distinct full ID.  Inspect B by exact returned ID and check its name/ownership, stopped state and isolation before comparing.  Compare the current reviewed `resolved_invariants` projections of A and B, normalizing only Config.Hostname and image-reference-versus-resolved-ID representation.  Compare full remaining Config, HostConfig, Mounts and immutable Image, including logging, limits, security, command, healthcheck, labels, mount access and sources.  Unexplained daemon-added/default fields cause failure; do not silently add normalization or start anything.
6. On a completely confirmed run, perform exact-ID cleanup below, then report invariant digests, a boolean equivalence result, mismatch field NAMES only, and exact cleanup confirmations.  Do not print raw Config, Env, inspect bodies or arbitrary daemon errors.

The only mutations allowed by an eventual release are the three named creates and exact fixture cleanup.  The transport must reject `/start`, `/stop`, `/restart`, `/exec`, `/archive`, `/update`, `/rename`, image pull/build/delete, network create/delete, volume pruning and all global prune routes before socket I/O.  It must not run a Docker CLI credential/config synchronization helper or invoke the production lifecycle class.

## Cleanup And Unknown Outcomes

On the confirmed path, reread each exact ID and require the full fixture labels, exact name, approved image ID and `Running=false` immediately before deletion.  Delete B and A only with `DELETE /containers/{exact-id}?v=false&force=false&link=false`; require HTTP 204.  Reinspect each exact ID/name and require HTTP 404.  Delete only the exact volume after independently verifying its full fixture labels/driver/options and confirming both containers are absent: `DELETE /volumes/{exact-name}?force=false`, HTTP 204, then exact-name GET 404.  Remove only the originally created RAM fixture files/directory after checking their recorded inode/owner and refusing symlinks.  Keep the cached image and every unrelated resource untouched.

An unknown create/delete outcome, identity mismatch, daemon change, unexpected running container or cleanup refusal terminates the procedure.  Do not retry a create, force-remove, stop a container, broadly select by prefix or delete an unverified resource.  Preserve known IDs, owned fixture resources and RAM evidence; perform only bounded read-only reconciliation against the exact reviewed names/IDs and notify the parent for a new finite cleanup decision.  Do not claim cleanup succeeded from the absence of an API error.

## Evidence And Limits

Success establishes the selected cached image's actual Engine API create/inspect reconstruction behavior for the exact synthetic configuration on this daemon/API version, with no process execution or network.  The production planner remains unchanged and disabled; its host-network requirement is not bypassed to run this test.  This probe deliberately uses network `none`, fixture labels and synthetic mounts.  It cannot establish production host-network behavior, actual hub image equivalence, journal continuity, snapshot credential custody, receiver delivery, billing or any permission to activate production.

Docker metadata, events and possibly daemon audit records are unavoidable effects of real create/delete calls.  Successful cleanup removes only the named fixture resources; it does not erase daemon history.  The parent has accepted this reversible boundary for planning, and a separate exact execution release is still required.

Primary API reference: [Docker Engine API v1.53](https://docs.docker.com/reference/api/engine/version/v1.53/).  The exact official schema and prospective executor must be checked together during parent review; this plan is not executable authorization.
