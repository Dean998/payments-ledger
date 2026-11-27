import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { Currency } from '../money.js';
import { accountToApi, createAccount, getAccount, listAccountLines } from './accounts.js';
import { entryToApi, getEntry } from './ledger.js';

export const ledgerRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    '/accounts',
    {
      schema: {
        body: z.object({
          name: z.string().min(1).max(200),
          currency: Currency,
          normalBalance: z.enum(['credit', 'debit']).optional(),
          allowNegative: z.boolean().optional(),
          metadata: z.record(z.string(), z.string()).optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(accountToApi(await createAccount(db, req.body))),
  );

  app.get('/accounts/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) =>
    accountToApi(await getAccount(db, req.params.id)),
  );

  app.get(
    '/accounts/:id/lines',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().regex(/^\d+$/).optional(),
        }),
      },
    },
    async (req) => listAccountLines(db, req.params.id, req.query),
  );

  app.get('/entries/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) =>
    entryToApi(await getEntry(db, req.params.id)),
  );
};
