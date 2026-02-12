import * as http from 'http';

export type OllamaMockScenario =
  | { type: 'static' }
  | { type: 'chatEcho' }
  | { type: 'chatMultiChunk'; chunks: string[] };

export interface OllamaMockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeNDJSON(res: http.ServerResponse, objects: unknown[], delayMs = 0): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');

  let index = 0;
  const writeNext = () => {
    if (index >= objects.length) {
      res.end();
      return;
    }
    res.write(JSON.stringify(objects[index]) + '\n');
    index++;
    if (delayMs > 0) {
      setTimeout(writeNext, delayMs);
    } else {
      setImmediate(writeNext);
    }
  };

  writeNext();
}

export async function startOllamaMockServer(
  scenario: OllamaMockScenario = { type: 'static' }
): Promise<OllamaMockServer> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';

      if (req.method === 'GET' && url === '/api/tags') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            models: [
              {
                name: 'test-model',
                modified_at: new Date().toISOString(),
                size: 1,
                digest: 'sha256:test'
              }
            ]
          })
        );
        return;
      }

      if (req.method === 'POST' && url === '/api/chat') {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};

        const lastMessageContent =
          parsed?.messages?.length ? parsed.messages[parsed.messages.length - 1]?.content : '';

        if (scenario.type === 'chatEcho') {
          const content = `echo:${String(lastMessageContent ?? '')}`;
          writeNDJSON(res, [
            { model: parsed.model, message: { role: 'assistant', content: content.slice(0, 4) }, done: false },
            { model: parsed.model, message: { role: 'assistant', content: content.slice(4) }, done: true }
          ]);
          return;
        }

        if (scenario.type === 'chatMultiChunk') {
          const objs = scenario.chunks.map((c, i) => ({
            model: parsed.model,
            message: { role: 'assistant', content: c },
            done: i === scenario.chunks.length - 1
          }));
          writeNDJSON(res, objs);
          return;
        }

        writeNDJSON(res, [
          { model: parsed.model, message: { role: 'assistant', content: 'hello' }, done: false },
          { model: parsed.model, message: { role: 'assistant', content: ' world' }, done: true }
        ]);
        return;
      }

      if (req.method === 'POST' && url === '/api/generate') {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const prompt = String(parsed?.prompt ?? '');

        writeNDJSON(res, [
          { model: parsed.model, response: prompt.slice(0, 5), done: false },
          { model: parsed.model, response: prompt.slice(5), done: true }
        ]);
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e: any) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e?.message ?? String(e) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start mock server');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      })
  };
}
