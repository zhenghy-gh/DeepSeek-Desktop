import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { forwardRequest } from '../src/upstream.js';

test('forwardRequest：白名单头透传，且不覆盖 Authorization/Content-Type', async () => {
  let capturedHeaders = null;
  const upstream = http.createServer((req, res) => {
    capturedHeaders = req.headers;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  const result = await forwardRequest(
    { baseUrl: base, apiKey: 'secret', path: '/v1/chat/completions' },
    { model: 'm1', messages: [] },
    {
      passthroughHeaders: {
        'OpenAI-Organization': 'org-1',
        'X-Custom': 'v',
        Authorization: 'should-be-ignored',
        'Content-Type': 'should-be-ignored',
      },
    }
  );
  assert.equal(result.ok, true);
  assert.equal(capturedHeaders['openai-organization'], 'org-1');
  assert.equal(capturedHeaders['x-custom'], 'v');
  assert.equal(capturedHeaders['authorization'], 'Bearer secret', '鉴权必须用账号 apiKey');
  assert.equal(capturedHeaders['content-type'], 'application/json');
  upstream.close();
});
