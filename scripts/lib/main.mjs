// Symlink-safe "was this module run directly?" check.
//
// `import.meta.url` carries the REAL path (macOS /tmp is a symlink to
// /private/tmp; /var likewise), while process.argv[1] is the path as typed — a
// naive string comparison silently fails and the CLI never runs. Resolving
// both through realpath makes the check correct everywhere.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
