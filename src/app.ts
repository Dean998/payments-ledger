import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Db } from './db/pool.js';
import { DomainError } from './errors.js';
import { ledgerRoutes } from './ledger/routes.js';
import { httpRequestDuration, registry } from './observability/metrics.js';
import { reconciliationRoutes } from './reconciliation/routes.js';
import { transferRoutes } from './transfers/routes.js';
import { webhookRoutes } from './webhooks/routes.js';

export function buildApp(deps: { db: Db; logger?: FastifyServerOptions['logger'] }) {
  const app = Fastify({
    logger: deps.logger ?? false,
    requestIdHeader: 'x-request-id',
    // Correlates logs from the gateway, this API and the worker.
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof DomainError) return reply.code(err.httpStatus).send(err.toResponse());
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: {
          code: 'validation_error',
          message: 'request validation failed',
          details: {
            issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
          },
        },
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: 'bad_request', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.addHook('onResponse', async (req, reply) => {
    httpRequestDuration.observe(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/health', async () => {
    await deps.db.query('SELECT 1');
    return { status: 'ok' };
  });

  app.get('/metrics', async (_req, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );

  void app.register(ledgerRoutes, { db: deps.db });
  void app.register(transferRoutes, { db: deps.db });
  void app.register(webhookRoutes, { db: deps.db });
  void app.register(reconciliationRoutes, { db: deps.db });

  return app;
}
