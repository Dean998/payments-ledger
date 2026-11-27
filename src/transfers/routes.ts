import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { hashRequest, runIdempotent } from '../idempotency/idempotency.js';
import { transferRejections, transfersCreated } from '../observability/metrics.js';
import {
  cancelTransfer,
  createTransfer,
  CreateTransferInput,
  getTransfer,
  listTransferEvents,
  transferToApi,
} from './transfers.js';

const Params = z.object({ id: z.uuid() });

export const transferRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    '/transfers',
    {
      schema: {
        // looseObject: keep every other header; only this one is required.
        headers: z.looseObject({ 'idempotency-key': z.string().min(1).max(255) }),
        body: CreateTransferInput,
      },
    },
    async (req, reply) => {
      const result = await runIdempotent(
        db,
        {
          scope: 'POST /transfers',
          key: req.headers['idempotency-key'],
          requestHash: hashRequest(req.body),
        },
        async (tx) => ({ status: 201, body: transferToApi(await createTransfer(tx, req.body)) }),
      );
      if (result.replayed) {
        reply.header('idempotent-replayed', 'true');
      } else if (result.status === 201) {
        transfersCreated.inc({ type: req.body.type });
      } else {
        const code = (result.body as { error?: { code?: string } }).error?.code ?? 'unknown';
        transferRejections.inc({ code });
      }
      return reply.code(result.status).send(result.body);
    },
  );

  app.get('/transfers/:id', { schema: { params: Params } }, async (req) =>
    transferToApi(await getTransfer(db, req.params.id)),
  );

  app.post('/transfers/:id/cancel', { schema: { params: Params } }, async (req) =>
    transferToApi(await cancelTransfer(db, req.params.id)),
  );

  app.get('/transfers/:id/events', { schema: { params: Params } }, async (req) => ({
    data: await listTransferEvents(db, req.params.id),
  }));
};
