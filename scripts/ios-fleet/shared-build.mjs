// Pure build planner.  No network, uploads or release state changes.
// One shared merge-timestamp build per app across iOS and macOS (owner, Oct 29 2026).
// next = max(S, M + 1) as a plain integer, where S is the committer date of
// the commit being built (HEAD) in America/Chicago as YYYYMMDDHHMM and M is
// the highest first numeric component among every iOS build, every macOS
// build and every extra floor.  A rebuild of the same commit still goes up,
// because the just-shipped build is in the inventory by then.  Every build
// counts, old iOS timestamp-style builds included; there is no 1000 floor
// and no 9999 cap.  The result is always a 12-digit merge-stamp build: a
// plan above 12 digits throws instead of emitting a value the shell gate
// would reject.
export function nextSharedBuild({iosBuilds, macBuilds, extraFloors = [], complete, mergeStamp}) {
  if (complete !== true || !Array.isArray(iosBuilds) || !Array.isArray(macBuilds)) {
    throw new Error('complete build inventory required');
  }
  if (typeof mergeStamp !== 'string' || !/^[1-9][0-9]{11}$/.test(mergeStamp)) {
    throw new Error('malformed merge stamp');
  }
  if (!Array.isArray(extraFloors)) throw new Error('malformed build inventory');
  for (const floor of extraFloors) {
    if (typeof floor === 'number') {
      if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('malformed build inventory');
    } else if (typeof floor === 'string') {
      if (!/^[0-9]+$/.test(floor)) throw new Error('malformed build inventory');
    } else {
      throw new Error('malformed build inventory');
    }
  }
  // Validate everything before computing; malformed evidence is never ignored.
  const re = /^[0-9]+(\.[0-9]+){0,2}$/;
  for (const value of [...iosBuilds, ...macBuilds]) {
    if (typeof value !== 'string' || !re.test(value)) throw new Error('malformed build inventory');
  }
  let m = null;
  const consider = (value) => {
    if (m === null || value > m) m = value;
  };
  for (const value of [...iosBuilds, ...macBuilds]) {
    consider(BigInt(value.split('.')[0]));
  }
  for (const floor of extraFloors) {
    consider(BigInt(floor));
  }
  const stamp = BigInt(mergeStamp);
  let next = stamp;
  if (m !== null) {
    const candidate = m + 1n;
    if (candidate > next) next = candidate;
  }
  const planned = String(next);
  if (planned.length > 12) throw new Error('planned build exceeds 12 digits');
  return {build: planned};
}
