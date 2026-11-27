/**
 * A tiny webhook receiver for the local demo. It verifies every signature and
 * logs the event, which shows the receiving side of the contract.
 */
import { createServer } from 'node:http';
import { verify } from '../webhooks/signing.js';

const secret = process.env.WEBHOOK_SECRET;
const port = Number(process.env.PORT ?? 4000);
if (!secret) throw new Error('WEBHOOK_SECRET is required');

const seen = new Set<string>();

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = {
      'webhook-id': req.headers['webhook-id'] as string,
      'webhook-timestamp': req.headers['webhook-timestamp'] as string,
      'webhook-signature': req.headers['webhook-signature'] as string,
    };
    if (!verify(secret, headers, body)) {
      console.log(
        JSON.stringify({ msg: 'rejected webhook: bad signature', id: headers['webhook-id'] }),
      );
      return void res.writeHead(401).end();
    }
    // At-least-once delivery: the same event can arrive twice.
    const duplicate = seen.has(headers['webhook-id']);
    seen.add(headers['webhook-id']);
    const event = JSON.parse(body) as {
      type: string;
      data: { id: string; status: string; amount: number };
    };
    console.log(
      JSON.stringify({
        msg: 'webhook received',
        type: event.type,
        transfer: event.data.id,
        status: event.data.status,
        duplicate,
      }),
    );
    res.writeHead(204).end();
  });
}).listen(port, () => console.log(JSON.stringify({ msg: `webhook sink listening on :${port}` })));
