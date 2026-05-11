// Durable Object for global, per-counter daily rate limiting.
// Replaces the per-isolate in-memory Map (which the May 2026 hostile-CTO audit
// flagged as bypassable: each Workers isolate had its own Map, so a 10k/day
// limit effectively became 10k × N_isolates per day).
//
// One DO instance per logical counter key (e.g. `key:<api_key_id>` or
// `ip:<client_ip>`). DO storage gives us strict-serializable counts across
// every isolate in every region.

import { DurableObject } from 'cloudflare:workers';

interface BucketState {
  day: string; // UTC YYYY-MM-DD
  count: number;
}

const STORAGE_KEY = 'bucket';

export class RateLimitCounter extends DurableObject {
  async bumpAndCheck(limit: number): Promise<{ allowed: boolean; count: number }> {
    const today = new Date().toISOString().slice(0, 10);
    const existing = (await this.ctx.storage.get<BucketState>(STORAGE_KEY)) ?? null;

    let bucket: BucketState;
    if (!existing || existing.day !== today) {
      bucket = { day: today, count: 0 };
    } else {
      bucket = existing;
    }

    if (bucket.count >= limit) {
      // Persist anyway so future sameDay reads see the latest state.
      await this.ctx.storage.put(STORAGE_KEY, bucket);
      return { allowed: false, count: bucket.count };
    }

    bucket.count += 1;
    await this.ctx.storage.put(STORAGE_KEY, bucket);
    return { allowed: true, count: bucket.count };
  }

  // Diagnostic — used by tests/admin only.
  async peek(): Promise<BucketState | null> {
    return (await this.ctx.storage.get<BucketState>(STORAGE_KEY)) ?? null;
  }

  // Test/admin reset.
  async reset(): Promise<void> {
    await this.ctx.storage.delete(STORAGE_KEY);
  }
}
