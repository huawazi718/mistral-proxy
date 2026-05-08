export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // req.url 格式: /api?path=/v1/chat/completions
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const originalPath = url.searchParams.get('path') || '/';
  const targetUrl = `https://api.mistral.ai${originalPath}`;

  // 透传 header
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([k]) => !['host', 'content-length'].includes(k.toLowerCase())
    )
  );

  let body = req.body;

  // 记录原始请求体的所有 key
  const originalKeys = body && typeof body === 'object' ? Object.keys(body) : [];
  const { messages: _msgs, ...originalParams } = body && typeof body === 'object' ? body : {};

  // 清理请求体：白名单模式，只保留 Mistral 接受的参数
  if (body && typeof body === 'object') {
    const allowedKeys = new Set([
      'model', 'messages', 'temperature', 'top_p', 'max_tokens',
      'stream', 'stream_options', 'stop', 'random_seed',
      'tools', 'tool_choice', 'response_format', 'n',
      'presence_penalty', 'frequency_penalty'
    ]);
    // max_completion_tokens → max_tokens 转换
    if ('max_completion_tokens' in body && !('max_tokens' in body)) {
      body.max_tokens = body.max_completion_tokens;
    }
    // 删除所有不在白名单中的 key
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        console.log(`[STRIP] removed "${key}": ${JSON.stringify(body[key])} from model ${body.model}`);
        delete body[key];
      }
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(body),
    });

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    const data = await response.json();
    // 如果 Mistral 返回错误，附加我们发送的请求体便于调试
    if (response.status >= 400) {
      data._debug_original_keys = originalKeys;
      data._debug_original_params = originalParams;
      const { messages: _m, ...sentParams } = body || {};
      data._debug_sent_params = sentParams;
    }
    return res.status(response.status).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
}
