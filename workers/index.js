/**
 * Unified API Proxy for Cloudflare Workers
 * Supports: Mistral + Gemini + Nvidia
 * v1.1.0
 */

const MISTRAL_API_BASE = "https://api.mistral.ai";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const NVIDIA_API_BASE = "https://integrate.api.nvidia.com";

// Gemini 模型列表
const GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-2.0-flash-exp",
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
  return /^models\/gemini/.test(lower) || /^gemini-[\w.-]+$/.test(lower);
}

function isMistralModel(model) {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.startsWith("mistral") || lower.startsWith("codestral") || lower.startsWith("pixtral");
}

// ============ Nvidia 代理 ============

async function handleNvidia(request, body, path) {
  const targetUrl = `${NVIDIA_API_BASE}${path}`;
  
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (!["host", "content-length", "content-encoding"].includes(lk)) {
      headers.set(key, value);
    }
  });
  
  console.log(`[NVIDIA] ${body?.model} stream=${body?.stream}`);
  
  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  
  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("text/event-stream")) {
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ============ Mistral 代理 ============

async function handleMistral(request, body, path) {
  const targetUrl = `${MISTRAL_API_BASE}${path}`;
  
  // 参数过滤
  if (body && typeof body === "object") {
    const allowedKeys = new Set([
      "model", "messages", "temperature", "top_p", "max_tokens",
      "stream", "stream_options", "stop", "random_seed",
      "tools", "tool_choice", "response_format", "n",
      "presence_penalty", "frequency_penalty"
    ]);
    
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
  
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (!["host", "content-length", "content-encoding"].includes(lk)) {
      headers.set(key, value);
    }
  });
  
  console.log(`[MISTRAL] ${body?.model} stream=${body?.stream}`);
  
  const response = await fetch(targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  
  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("text/event-stream")) {
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ============ Gemini 代理 ============

async function handleGemini(request, body) {
  const auth = request.headers.get("authorization");
  const apiKey = auth?.startsWith("Bearer ") ? auth.substring(7) : null;
  
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key required" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  
  try {
    const { model, messages, stream = false, temperature = 0.7, max_tokens = 2048 } = body;
    
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
    
    const geminiModel = model.replace(/^models\//, "");
    const keyParam = `?key=${apiKey}`;
    const endpoint = stream
      ? `/v1beta/models/${geminiModel}:streamGenerateContent${keyParam}&alt=sse`
      : `/v1beta/models/${geminiModel}:generateContent${keyParam}`;
    
    const targetUrl = `${GEMINI_API_BASE}${endpoint}`;
    
    console.log(`[GEMINI] ${geminiModel} stream=${stream}`);
    
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiRequest),
    });
    
    if (!response.ok) {
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    
    if (stream) {
      return handleGeminiStream(response, model);
    } else {
      const data = await response.json();
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
      
      return new Response(JSON.stringify(openaiResponse), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  } catch (error) {
    console.error("[GEMINI ERROR]", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

function handleGeminiStream(response, model) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  (async () => {
    const reader = response.body.getReader();
    let buffer = "";
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        await writer.close();
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
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          } catch (e) {}
        }
      }
    }
  })();
  
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ============ 主处理器 ============

export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key",
        },
      });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check
    if (path === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "CF Workers Unified Proxy v1.0.0",
        models: {
          mistral: ["mistral-large", "mistral-medium", "mistral-small", "codestral"],
          gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-flash-lite"],
          nvidia: ["minimaxai/minimax-m2.5", "minimaxai/minimax-m2.7", "z-ai/glm5", "z-ai/glm-5.1"],
        },
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    
    // Chat completions
    if (path === "/v1/chat/completions" || path === "/v1/chat/completions/") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      
      const body = await request.json();
      const model = body?.model;
      
      if (isGeminiModel(model)) {
        return handleGemini(request, body);
      } else if (isMistralModel(model)) {
        return handleMistral(request, body, path);
      } else {
        // 兜底：非 Gemini 非 Mistral 的模型全走 Nvidia
        return handleNvidia(request, body, path);
      }
    }
    
    // 其他 v1 路由走 Mistral
    if (path.startsWith("/v1/")) {
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      return handleMistral(request, body, path);
    }
    
    return new Response(JSON.stringify({ error: "Not found", path }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  },
};
