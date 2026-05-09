/**
 * Unified API Proxy - Mistral + Gemini
 * v2.0.0 - 根据模型名自动路由
 */

const MISTRAL_API_BASE = "https://api.mistral.ai";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// Gemini 模型列表（用于路由判断）
const GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3.5-pro",
]);

function isGeminiModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (GEMINI_MODELS.has(lower)) return true;
  // 匹配 models/gemini-xxx 或带版本后缀的模型
  return /^models\/gemini/.test(lower) || /^gemini-[\w.-]+$/.test(lower);
}

// ============ Mistral 代理 ============

function handleMistral(req, res, originalPath, body) {
  const targetUrl = `${MISTRAL_API_BASE}${originalPath}`;

  // 清理请求体：白名单模式
  if (body && typeof body === "object") {
    const allowedKeys = new Set([
      "model", "messages", "temperature", "top_p", "max_tokens",
      "stream", "stream_options", "stop", "random_seed",
      "tools", "tool_choice", "response_format", "n",
      "presence_penalty", "frequency_penalty"
    ]);
    // max_completion_tokens → max_tokens 转换
    if ("max_completion_tokens" in body && !("max_tokens" in body)) {
      body.max_tokens = body.max_completion_tokens;
    }
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        console.log(`[MISTRAL STRIP] "${key}" from model ${body.model}`);
        delete body[key];
      }
    }
  }

  const headers = {};
  Object.entries(req.headers).forEach(([k, v]) => {
    if (!["host", "content-length", "content-encoding"].includes(k.toLowerCase())) {
      headers[k] = v;
    }
  });

  fetch(targetUrl, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(body),
    duplex: "half",
  }).then(response => {
    // 透传限额头
    response.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (lk.startsWith("x-ratelimit") || lk.startsWith("ratelimit") ||
          lk === "retry-after" || lk.startsWith("x-mistral") || lk === "x-request-id") {
        res.setHeader(key, value);
      }
    });

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      response.body.pipe(res);
      return;
    }

    response.json().then(data => {
      if (response.status >= 400) {
        data._proxy = "mistral";
      }
      res.status(response.status).json(data);
    }).catch(() => {
      response.text().then(text => res.status(response.status).send(text));
    });
  }).catch(error => {
    console.error("[MISTRAL ERROR]", error);
    res.status(502).json({ error: "Mistral proxy failed", message: error.message });
  });
}

// ============ Gemini 代理 ============

function handleGemini(req, res, body) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: "API key required" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { model, messages, stream = false, temperature = 0.7, max_tokens = 2048 } = body;

    // 转换为 Gemini 格式
    const contents = messages.map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const geminiRequest = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: max_tokens,
      },
    };

    // 从模型名提取 Gemini 模型 ID（去掉 models/ 前缀）
    const geminiModel = model.replace(/^models\//, "");
    const endpoint = stream
      ? `/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse`
      : `/v1beta/models/${geminiModel}:generateContent`;

    const targetUrl = `${GEMINI_API_BASE}${endpoint}?key=${apiKey}`;

    console.log(`[GEMINI] ${req.method} ${geminiModel} stream=${stream}`);

    fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiRequest),
      duplex: "half",
    }).then(response => {
      if (!response.ok) {
        response.text().then(text => {
          console.log(`[GEMINI ERROR] ${response.status}: ${text}`);
          res.status(response.status).json(JSON.parse(text));
        });
        return;
      }

      if (stream) {
        handleGeminiStream(response, res, model);
      } else {
        response.json().then(data => {
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const openaiResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            }],
            usage: {
              prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
              completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
              total_tokens: data.usageMetadata?.totalTokenCount || 0,
            },
          };
          res.setHeader("Content-Type", "application/json");
          res.status(200).json(openaiResponse);
        }).catch(err => {
          console.error("[GEMINI PARSE ERROR]", err);
          res.status(500).json({ error: "Failed to parse Gemini response" });
        });
      }
    }).catch(error => {
      console.error("[GEMINI ERROR]", error);
      res.status(502).json({ error: "Gemini proxy failed", message: error.message });
    });

  } catch (error) {
    console.error("[GEMINI ERROR]", error);
    res.status(500).json({ error: error.message });
  }
}

function handleGeminiStream(response, res, model) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const { Readable } = require("stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function pump() {
    reader.read().then(({ done, value }) => {
      if (done) {
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.substring(6));
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
          } catch (e) {}
        }
      }
      pump();
    });
  }

  pump();
}

function getApiKey(req) {
  // 优先从 Authorization Bearer 获取
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) return auth.substring(7);

  // 其次从 body.api_key 获取
  if (req.body?.api_key) return req.body.api_key;

  return null;
}

// ============ 主处理器 ============

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-goog-api-key");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const path = url.searchParams.get("path") || "/";

  // 健康检查
  if (path === "/health") {
    return res.status(200).json({
      status: "ok",
      service: "Unified Proxy v2.0.0",
      models: {
        mistral: ["mistral-large", "mistral-medium", "mistral-small", "codestral"],
        gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-flash-lite"],
      },
    });
  }

  // ========== /v1/chat/completions 路由 ==========
  if (path === "/v1/chat/completions") {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const model = body?.model;

    if (isGeminiModel(model)) {
      return handleGemini(req, res, body);
    } else {
      return handleMistral(req, res, path, body);
    }
  }

  // ========== 其他 /v1/ 路径 → Mistral（默认） ==========
  if (path.startsWith("/v1/") && path !== "/v1/chat/completions") {
    return handleMistral(req, res, path, req.body);
  }

  // 其他路径
  res.status(404).json({ error: "Not found", path });
};
