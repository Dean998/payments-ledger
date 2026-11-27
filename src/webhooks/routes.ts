import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { createWebhookEndpoint, listDeliveries } from './endpoints.js';

export const webhookRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    '/webhook-endpoints',
    {
      schema: {
        body: z.object({
          url: z.url({ protocol: /^https?$/ }),
          eventTypes: z
            .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/))
            .min(1)
            .optional(),
          // Optional client-chosen secret (used by the local demo). Normally generated.
          secret: z.string().startsWith('whsec_').min(30).optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await createWebhookEndpoint(db, req.body)),
  );

  app.get(
    '/webhook-endpoints/:id/deliveries',
    { schema: { params: z.object({ id: z.uuid() }) } },
    async (req) => ({ data: await listDeliveries(db, req.params.id) }),
  );
};
