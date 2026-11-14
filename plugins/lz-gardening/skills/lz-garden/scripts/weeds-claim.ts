import { claimRefusal, replay } from './log.ts';
import type { ClaimEvent } from './log.ts';
import { reasonOf } from './cli.ts';
import { readLog } from './store-log.ts';
import type { Site } from './store-log.ts';
import { isShared } from './store-sync.ts';
import type { SyncResult } from './store-sync.ts';

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
      return claimedByLine(refusal.owner);
    }
  }
}

export function claimedByLine(owner: ClaimEvent): string {
  return `${owner.class} is claimed by ${owner.holder} until ${owner.until}`;
}
