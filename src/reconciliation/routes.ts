import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/pool.js';
import { errors } from '../errors.js';
import { latestReconciliation, runReconciliation } from './reconcile.js';

export const reconciliationRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get('/reconciliation/runs/latest', async () => {
    const run = await latestReconciliation(db);
    if (!run) throw errors.notFound('reconciliation run', 'latest');
    return run;
  });

  app.post('/reconciliation/runs', async (_req, reply) =>
    reply.code(201).send(await runReconciliation(db)),
  );
};
