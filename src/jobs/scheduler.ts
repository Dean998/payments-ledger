import type { Logger } from 'pino';
import { setTimeout as sleep } from 'node:timers/promises';
import { jobDuration } from '../observability/metrics.js';

export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * Runs each job in its own loop: run, wait, repeat. A slow run delays the
 * next one instead of overlapping with it. Errors are logged and the loop
 * continues. Several worker replicas can run at once, because every job
 * claims work with SELECT ... FOR UPDATE SKIP LOCKED.
 */
export function startJobs(jobs: Job[], log: Logger) {
  const controller = new AbortController();
  const loops = jobs.map(async (job) => {
    while (!controller.signal.aborted) {
      const end = jobDuration.startTimer({ job: job.name });
      try {
        const result = await job.run();
        end({ result: 'ok' });
        if (result && typeof result === 'object' ? Object.values(result).some((v) => v) : result) {
          log.debug({ job: job.name, result }, 'job run');
        }
      } catch (err) {
        end({ result: 'error' });
        log.error({ job: job.name, err }, 'job failed');
      }
      await sleep(job.everyMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  });
  return {
    async stop() {
      controller.abort();
      await Promise.all(loops);
    },
  };
}
