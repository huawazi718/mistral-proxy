export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 透传所有 header（排除 host 和 content-length）
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([k]) => !['host', 'content-length'].includes(k.toLowerCase())
    )
  );

  // 构建目标 URL
  const path = req.query.path || [];
  const targetUrl = `https://api.mistral.ai/${Array.isArray(path) ? path.join('/') : path}`;

  // 打印调试信息
  console.log('Request URL:', targetUrl);
  console.log('Request Method:', req.method);
  console.log('Request Headers:', JSON.stringify(headers, null, 2));

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
    return res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
}
