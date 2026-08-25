import { mergeHistoryBuckets } from './HistoryBucket.js';

const WIDTH = Object.freeze({ minute: 60_000, hour: 3_600_000, day: 86_400_000 });

export function utcBucketStart(timestamp, tier) {
  const width = WIDTH[tier];
  if (!width) throw new Error('tier must be minute, hour, or day');
  if (!Number.isFinite(timestamp)) throw new Error('timestamp must be finite');
  return Math.floor(timestamp / width) * width;
}

export class HistoricalCompactor {
  constructor(store) {
    if (!store || typeof store.readBuckets !== 'function' || typeof store.replaceCompactedBucket !== 'function') {
      throw new Error('historical store is required');
    }
    this.store = store;
    this.inFlight = new Set();
  }

  compact({ project, sourceTier, destinationTier, destinationFrom, finalized }) {
    const expectedDestination = sourceTier === 'minute' ? 'hour' : sourceTier === 'hour' ? 'day' : null;
    if (destinationTier !== expectedDestination) {
      throw new Error('compaction tier pair must be minute-to-hour or hour-to-day');
    }
    const from = utcBucketStart(destinationFrom, destinationTier);
    if (from !== destinationFrom) throw new Error('destinationFrom must be UTC aligned');
    const to = from + WIDTH[destinationTier];
    const key = `${project}\0${sourceTier}\0${destinationTier}`;
    if (this.inFlight.has(key)) throw new Error('compaction is already in flight for project and tier');
    this.inFlight.add(key);
    try {
      const sourceBuckets = this.store.readBuckets({ project, tier: sourceTier, from, to });
      if (sourceBuckets.some((bucket) => !bucket.finalized)) {
        throw new Error('compaction requires closed source buckets');
      }
      const bucket = mergeHistoryBuckets({ project, tier: destinationTier, from, to, sourceBuckets, finalized });
      return this.store.replaceCompactedBucket({
        sourceTier,
        destinationTier,
        bucket,
        sourceThrough: to
      });
    } finally {
      this.inFlight.delete(key);
    }
  }
}
