export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 从 req.url 提取原始路径（rewrite 前的路径通过 x-vercel-rewrite 传递）
  const originalPath = req.headers['x-vercel-rewrite'] || req.url || '/';
  // 去掉 query string
  const pathWithoutQuery = originalPath.split('?')[0];
  const targetUrl = `https://api.mistral.ai${pathWithoutQuery}`;

  // 透传 header（排除 host 和 content-length）
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([k]) => !['host', 'content-length', 'x-vercel-rewrite'].includes(k.toLowerCase())
    )
  );

  console.log('targetUrl:', targetUrl, 'Authorization:', headers['authorization'] ? '有' : '无');

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
