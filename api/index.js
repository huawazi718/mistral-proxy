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

  console.log('---REQUEST---');
  console.log('targetUrl:', targetUrl, 'Authorization:', headers['authorization'] ? '有' : '无');
  if (req.body) {
    const { messages, ...rest } = req.body;
    console.log('body params:', JSON.stringify(rest, null, 2));
  }

  // DEBUG: 如果 path 包含 debug，返回请求体而不是转发
  if (originalPath.includes('debug')) {
    return res.status(200).json({
      targetUrl,
      method: req.method,
      body: req.body,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([k]) => !['authorization'].includes(k.toLowerCase()))
      )
    });
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
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
