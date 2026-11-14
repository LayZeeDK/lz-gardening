import { claimRefusal, replay } from './log.ts';
import { reasonOf } from './cli.ts';
import { readLog } from './store-log.ts';
import type { Site } from './store-log.ts';
import { isShared } from './store-sync.ts';
import type { SyncResult } from './store-sync.ts';

// bed and close-class act on a class only under this writer's live claim, read after a sync that left the log local
// or shared, so another clone's newer claim is seen and this claim is on origin when there is one. Why they may not,
// or undefined.
export function claimRefusalLine(site: Site, weedClass: string, pre: SyncResult, now: Date): string | undefined {
  if (!isShared(pre)) {
    return `cannot check the claim of ${weedClass}: ${pre.state}${reasonOf(pre)}`;
  }

  const refusal = claimRefusal(replay(readLog(site).events, now), weedClass, site.writer);

  switch (refusal?.kind) {
    case undefined: {
      return undefined;
    }
    case 'unclaimed': {
      return `this site holds no claim of ${weedClass}; run weeds claim --class ${weedClass}`;
    }
    case 'held': {
      return `${weedClass} is claimed by ${refusal.owner.holder} until ${refusal.owner.until}`;
    }
  }
}
