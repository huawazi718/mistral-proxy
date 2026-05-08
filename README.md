# Mistral API 代理

通过 Vercel 部署的 Mistral API 代理，用于国内访问。

## 部署步骤

1. 在 Vercel 导入此 GitHub 仓库
2. 点击 Deploy
3. 完成！

## 使用方式

把 API 请求地址改为你的 Vercel 域名：

```
原地址: https://api.mistral.ai/v1/chat/completions
改为: https://你的项目名.vercel.app/v1/chat/completions
```

请求时带上你的 Mistral API Key（Authorization header），代理会原样转发。
