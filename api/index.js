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

  // 清理请求体：移除 Mistral 不支持的参数
  let body = req.body;
  if (body && typeof body === 'object') {
    // 移除 QClaw 自动添加但 Mistral 不接受的参数
    const forbiddenKeys = ['reasoning_effort', 'thinking', 'thinking_budget'];
    for (const key of forbiddenKeys) {
      if (key in body) {
        console.log(`[STRIP] removed "${key}": ${JSON.stringify(body[key])} from model ${body.model}`);
        delete body[key];
      }
    }
    // 记录清理后的完整请求体（不含 messages 内容）
    const { messages, ...rest } = body;
    console.log('[CLEANED BODY]', JSON.stringify(rest, null, 2));
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
    return res.status(response.status).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
}
