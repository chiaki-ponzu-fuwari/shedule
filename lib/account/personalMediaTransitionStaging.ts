import type { PersonalSnapshot } from '../../types/account';
import type { PersonalMediaService } from './personalMedia';
import {
  discoverPendingPersonalMediaTargets,
  type PersonalMediaSyncPersistence,
  type PersonalMediaTarget,
} from './personalMediaSync';

function sameTarget(left: PersonalMediaTarget, right: PersonalMediaTarget): boolean {
  return left.entity === right.entity
    && left.entityId === right.entityId
    && left.domain === right.domain
    && left.field === right.field
    && left.index === right.index;
}

/** Prepares guest media while blob/content URIs are still readable. */
export function createPersonalMediaTransitionStager({
  persistence,
  service,
  now = () => new Date(),
}: {
  persistence: PersonalMediaSyncPersistence;
  service: Pick<PersonalMediaService, 'prepare'>;
  now?: () => Date;
}) {
  return {
    async stage(ownerId: string, snapshot: PersonalSnapshot): Promise<void> {
      const state = await persistence.read(ownerId);
      for (const source of discoverPendingPersonalMediaTargets(snapshot)) {
        const existing = state.uploads.find((job) => sameTarget(job.target, source));
        if (existing?.sourceUri === source.sourceUri) continue;
        if (existing) {
          if (!state.stagedCleanups.some((cleanup) => (
            cleanup.stagedUri === existing.pending.stagedUri
            && cleanup.afterMutationId === existing.pending.mutationId
          ))) {
            state.stagedCleanups.push({
              stagedUri: existing.pending.stagedUri,
              afterMutationId: existing.pending.mutationId,
            });
          }
          if (!state.cleanups.some(
            (cleanup) => cleanup.objectKey === existing.pending.objectKey,
          )) {
            state.cleanups.push({
              objectKey: existing.pending.objectKey,
              queuedAt: now().toISOString(),
            });
          }
          state.uploads = state.uploads.filter(
            (job) => job.pending.mutationId !== existing.pending.mutationId,
          );
          // Persist cleanup intent before replacing the only pointer to the old
          // stage. An ambiguous prior upload is therefore never orphaned.
          await persistence.write(ownerId, state);
        }
        await service.prepare({
          ownerId,
          domain: source.domain,
          sourceUri: source.sourceUri,
          persistPending: async (pending) => {
            state.uploads.push({
              target: {
                entity: source.entity,
                entityId: source.entityId,
                domain: source.domain,
                field: source.field,
                ...(source.index === undefined ? {} : { index: source.index }),
              },
              sourceUri: source.sourceUri,
              phase: 'prepared',
              pending,
            });
            await persistence.write(ownerId, state);
          },
        });
      }
    },
  };
}
