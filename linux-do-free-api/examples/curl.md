# 常见调用示例（curl）

下面假设代理运行在 `http://127.0.0.1:3090`，并已设置：

- `ADMIN_TOKEN=admin123`（管理端保护）
- `PROXY_AUTH_TOKEN=proxy456`（代理端保护，可选）

> 未设置令牌时本地默认开放，以下示例省略 `Authorization` 头即可。

## 1. 添加账号

```bash
curl -X POST http://127.0.0.1:3090/admin/pool \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer admin123' \
  -d '{
    "name": "我的中转站",
    "baseUrl": "https://relay.example.com",
    "apiKey": "sk-xxxxxxxx",
    "models": "gpt-4o,claude-3-5-sonnet",
    "groups": "premium,fast",
    "weight": 3
  }'
```

## 2. 发起一次对话（走号池选号 + 故障转移）

```bash
curl -X POST http://127.0.0.1:3090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer proxy456' \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role":"user","content":"你好"}],
    "stream": false
  }'
```

走指定分组（只从 `premium` 组选号）：

```bash
curl -X POST http://127.0.0.1:3090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer proxy456' \
  -H 'X-LDFA-Group: premium' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

## 3. 流式对话

```bash
curl -N -X POST http://127.0.0.1:3090/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer proxy456' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"讲个故事"}],"stream":true}'
```

## 4. Embeddings

```bash
curl -X POST http://127.0.0.1:3090/v1/embeddings \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer proxy456' \
  -d '{"model":"text-embedding-3-small","input":"hello world"}'
```

## 5. 通用 OpenAI 兼容端点（图片 / 音频等）

任意 `/v1/*` 路径都会按原路径透传，例如文生图：

```bash
curl -X POST http://127.0.0.1:3090/v1/images/generations \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer proxy456' \
  -d '{"model":"dall-e-3","prompt":"a cute cat","n":1,"size":"1024x1024"}'
```

## 6. 查看指标 / 号池

```bash
curl http://127.0.0.1:3090/metrics                         # 指标（JSON）
curl 'http://127.0.0.1:3090/metrics?format=prometheus'     # Prometheus 格式
curl -H 'Authorization: Bearer admin123' http://127.0.0.1:3090/admin/pool
```

## 7. 探活 / 体检

```bash
# 仅报告可达性
curl -X POST -H 'Authorization: Bearer admin123' http://127.0.0.1:3090/admin/health-check

# 不可达的账号自动下线
curl -X POST -H 'Authorization: Bearer admin123' -H 'Content-Type: application/json' \
  -d '{"autoDisable":true}' http://127.0.0.1:3090/admin/health-check
```

## 8. 备份 / 恢复

```bash
curl -H 'Authorization: Bearer admin123' http://127.0.0.1:3090/admin/backup -o backup.json
curl -X POST -H 'Authorization: Bearer admin123' -H 'Content-Type: application/json' \
  --data @backup.json http://127.0.0.1:3090/admin/restore
```

## 9. CLI 批量管理

```bash
node src/cli.js status
node src/cli.js stats
node src/cli.js list --group premium
node src/cli.js disable --group free      # 禁用 free 组全部
node src/cli.js enable --all              # 启用全部
node src/cli.js export --out backup.json  # 导出
node src/cli.js restore --file backup.json # 恢复
```
