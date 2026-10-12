import fs from "node:fs";
import path from "node:path";

function canonical(directory) {
  const real = fs.realpathSync.native(directory);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

// Git reports a worktree root in canonical form (long names, no links), but a
// caller reaches the same folder by whatever spelling it was given, e.g. the
// 8.3 short name of a CI runner's temp folder. Comparing the two spellings
// textually makes a legitimate private output look like it escaped the
// worktree.
//
// `markerRoot` is the folder holding `.git`, in the caller's spelling.
// Returns the spelling to measure outputs against: `markerRoot` when it is
// the same folder as `gitRoot` and is not itself a link, otherwise `gitRoot`
// (so a mismatch still fails the caller's "inside the worktree" check).
// Links below the root are not resolved here; the callers check those
// separately, so a redirected output is never resolved away.
export function worktreeBase(markerRoot, gitRoot) {
  const marker = path.resolve(markerRoot);
  const root = path.resolve(gitRoot);
  try {
    if (fs.lstatSync(marker).isSymbolicLink()) return root;
    if (canonical(marker) === canonical(root)) return marker;
  } catch {
    // An unreadable marker folder cannot be proven to be the root.
  }
  return root;
}
