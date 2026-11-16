# Stopped Engine Fixture: Exact Cleanup Plan

This plan requires a separate release before any deletion.  The single released probe stopped after A creation returned warnings; no retry, B creation, start or cleanup occurred.  Create/inspect equivalence remains unverified.

The original warning body was not retained.  Readback establishes that the cgroup-v2 daemon changed requested `MemorySwappiness=0` to null, and its installed binary contains the unsupported-swappiness warning template.  That supports the warning category but does not recover or prove the exact response text.  An in-memory copy with only requested swappiness restored passes the closed Config/HostConfig validator; the mount representation difference consists of omitted optional false/default declarations.

## Fixed Scope

- Reviewed executor SHA256: `da431146b352cc047313624f04d2041073d7d093928308b6b6115217362f1b32`.
- Reviewed original plan SHA256: `ca0b792e8273ae04154774aa7f12adf09fe1f87deb525a883f4597ffc2e7d361`.
- Local daemon-ID SHA256: `659e19e4b792e0ed00b136b7e91ad7ae1ea7decbf9e7930cdf1488d69b496565`.
- A full ID: `a2272125598a8a0b3726c894e2dde2a8f3ca76ab6f3bc5a68cc285ab386256d5`.
- A name: `um1654-repr-01a1a250-6bd2a7ec-a`.
- B name: `um1654-repr-01a1a250-6bd2a7ec-b`; readback is 404.
- Volume: `um1654-repr-01a1a250-6bd2a7ec-journal`.
- RAM directory: `/dev/shm/um1654-repr-01a1a250-6bd2a7ec`.
- A immutable image ID: `sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea`.
- A full invariant projection SHA256: `babd1cf7751a91abfd6986b3fd71f1c423676e1ce7d8f19b08f66104cbcb0663`.

Container labels must exactly equal the original executor's `LABELS`: task `UM-1654`, session `01a1a250-33bb-7a52-b3e9-32f1a80699a8`, nonce `6bd2a7ec`, role `container`.  Volume labels must exactly equal its `VOLUME_LABELS`, with role `journal`.  Volume driver must remain `local`; options must exactly equal `type=tmpfs`, `device=tmpfs`, `o=size=1m,uid=10001,gid=10001`.

## Preconditions And Finite Sequence

1. Verify the unchanged executor and this separately reviewed cleanup artifact hash.  Use its fixed socket, bounded transport and same-connection daemon fingerprint check for each mutation; never use a Docker context or retry a mutation.
2. Open the exact RAM directory without following symlinks.  Require device 26, inode 1742540, UID 1001, mode 0700 and exactly the four entries below.  Verify each entry's regular-file identity, owner, mode, size and content hash with bounded no-follow reads before any mutation; retain the directory descriptor through cleanup.
3. Read exact A full ID and name, exact B name and exact volume.  Require A ID/name/image/labels to match; require `State.Status=created`, `Running=false`, `Paused=false`, `Restarting=false`, `Dead=false`, `Pid=0`.  Require the full invariant projection hash above; do not weaken validation or accept additional drift.  Require B 404 and the exact volume identity/options/labels above.
4. Send exactly one `DELETE /containers/a2272125598a8a0b3726c894e2dde2a8f3ca76ab6f3bc5a68cc285ab386256d5?v=false&force=false&link=false` using the reviewed pinned transport.  Require 204, then require exact A ID and A name both 404.  An unknown response, mismatch or non-204 stops without retry or further cleanup.
5. Re-read B and require 404; re-read the exact volume and verify its complete identity/options/labels again.  Send exactly one `DELETE /volumes/um1654-repr-01a1a250-6bd2a7ec-journal?force=false`; require 204 and exact-volume GET 404.  A conflict or unknown outcome stops and preserves RAM evidence; never force removal or enumerate/remove unrelated resources.
6. Recheck the retained RAM descriptor, path identity and every exact file identity/hash.  Unlink only the four listed names through that descriptor, then remove only the exact empty original directory after confirming its path identity again.  No recursion, glob, prefix cleanup or ignored errors.  An unexpected entry, changed identity or unknown removal outcome stops and preserves remaining evidence.
7. Final bounded readback requires exact A ID/name, B name and volume all 404, and the exact RAM path absent.  Report every attempted mutation and result; absence alone does not erase daemon event history or prove equivalence.

The cleanup executor must expose no create, start, exec, pull, prune or production-resource route.  Cap the whole run at 18 Engine wire requests including an initial fingerprint read and mutation handshakes, with the unchanged absolute deadline and byte limits.  Failed preconditions perform zero mutations.  Stop on any uncertainty; further action requires a new release.

## Exact RAM Entries

All files are device 26, UID 1001, mode 0600.  These are synthetic fixture evidence, containing no production configuration or credentials.

| Name | Inode | Bytes | SHA256 |
| --- | --- | --- | --- |
| `config.json` | 1742541 | 42 | `1a048d46429d7fcb16f690cf8b3a41118685fb53d2218522b2ca9e6020548d5c` |
| `container-0-intent.json` | 1742544 | 126 | `c94c1d588c967119d96c0e4360ae48a43446260e769da160a8d677428f769080` |
| `volume-confirmed.json` | 1742543 | 133 | `98adc4613f110843c64eb2e0ab168abf83835253865abec74596feb5660f6d4d` |
| `volume-intent.json` | 1742542 | 48 | `e11d16a698d37abf1afb4a3875dfe2bc6c66fd3a576736e0f0b31d5463214d0f` |

No production hub, source map, service, image, journal, credential, configuration or lifecycle operation is included.
