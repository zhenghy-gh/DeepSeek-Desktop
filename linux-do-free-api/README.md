# linux-do-free-api

从 [linux.do](https://linux.do) 上收集网友分享的「免费中转站」账号，汇聚成你自己的**号池**，并提供一个 **OpenAI 兼容代理**：自动按模型选号、**额度耗尽自动切换**到下一个可用账号。

> 配套桌面端见上级目录 `DeepSeek-Desktop`（Electron）。本服务为零依赖 Node.js，未来可由桌面端像 Harness 一样自动拉起，作为本地 `http://127.0.0.1:3090` 的 OpenAI 兼容端点。

## 它能做什么

- **号池管理**：把你注册/签到得到的多个中转站账号（baseUrl + apiKey + 支持模型）统一管理在一个 JSON 文件里。
- **OpenAI 兼容代理**：暴露 `POST /v1/chat/completions`，客户端（OpenAI SDK、ChatBox、桌面端等）无需关心背后是哪个中转站。
- **自动选模型**：请求里带 `model`，代理自动从号池里挑一个支持该模型且健康的账号。
- **额度耗尽自动切换**：某个账号返回 `429` / 额度相关错误时，自动标记为「耗尽」并进入冷却，立即换下一个账号重试；冷却结束（默认按天重置）自动复活。
- **Key 失效自动停用**：`401` / 鉴权错误会停用该账号，避免反复浪费请求。
- **负载均衡**：在健康账号间按权重 + 最近使用时间做随机扰动分发。

## 快速开始

```bash
cd linux-do-free-api

# 1) 添加一个中转站账号（模型用逗号分隔）
node src/cli.js add \
  --name "我的中转A" \
  --base-url https://relay-a.example.com \
  --api-key sk-xxxx \
  --models deepseek-chat,gpt-4o-mini,claude-3-5-haiku

# 2) 查看号池
node src/cli.js list
node src/cli.js status

# 3) 启动代理（默认 127.0.0.1:3090）
node src/index.js
# 或 npm start
```

## 当作 OpenAI 端点使用

任何支持自定义 `base_url` 的客户端都能直接用：

```bash
curl http://127.0.0.1:3090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3090/v1", api_key="anything")
print(client.chat.completions.create(model="deepseek-chat", messages=[{"role":"user","content":"你好"}]))
```

## CLI 命令

| 命令 | 说明 |
| --- | --- |
| `add --base-url --api-key [--name] [--models m1,m2] [--weight n]` | 录入账号 |
| `import --file <path> \| --url <url> [--format auto\|json\|env\|codex\|oneapi\|nextchat] [--dry-run] [--name-prefix <p>]` | 从平台导出批量导入账号 |
| `list` | 列出号池（表格） |
| `remove --id <id>` | 删除账号 |
| `enable --id <id>` / `disable --id <id>` | 启/禁用账号 |
| `status` | 号池健康概览 |
| `serve` | 启动代理（同 `npm start`） |

配置项（环境变量）：`PORT`（默认 3090）、`HOST`（默认 127.0.0.1）、`DATA_FILE`（号池文件路径）、`ADMIN_TOKEN`（`/admin/pool` 接口的保护令牌，不设置则本地开放）。

## 从常用平台批量导入账号

很多 OpenAI 兼容中转站 / 聚合平台（**Codex、One API / New API、NextChat、以及各中转站仪表盘的「导出配置」**）的账号信息都是同一套字段（`base_url` + `api_key` + `models`）。用 `import` 命令可以直接把它们批量录入号池，无需逐个 `add`。

```bash
# 从本地文件导入（自动识别 JSON / .env 格式）
node src/cli.js import --file ./codex-export.json

# 从远程 URL 拉取配置再导入
node src/cli.js import --url https://my-dashboard.example.com/export

# 先用 dry-run 预览会导入哪些、跳过哪些，确认无误再去掉 --dry-run
node src/cli.js import --file ./export.json --dry-run

# 指定格式 / 加名字前缀 / 区分来源
node src/cli.js import --file ./nextchat.json --format nextchat --name-prefix codex
```

支持的格式（`--format`）：

- `auto`（默认）：先按 `.env` 嗅探，否则按 JSON 解析；JSON 内部兼容数组、单个对象、`{ data: [...] }`、`{ openai: {...} }`（NextChat）等多种嵌套。
- `json` / `codex` / `oneapi` / `nextchat`：统一走 JSON 归一化（字段名大小写 / 同义键都已容错：`base_url`/`endpoint`/`url`、`api_key`/`key`/`token`/`sk` 等）。
- `env`：解析 `OPENAI_BASE_URL` + `OPENAI_API_KEY`（以及常见同义键）的 `.env` 文件。

导入行为：

- **去重**：号池里已存在相同 `api_key` 或 `(base_url + api_key)` 的账号会被跳过，不会重复录入。
- **模型**：导入时若带 `models` 则照单全收；不带则留空（代理会匹配该账号支持的任何模型）。
- 预览：`--dry-run` 只打印将要新增的账号，不写入文件。

## 工作原理

```
客户端
  │  POST /v1/chat/completions  { model: "deepseek-chat" }
  ▼
代理 (号池路由器)
  │  1. 从号池筛选「支持该模型 + 健康」的候选
  │  2. 按策略挑一个账号 → 转发上游
  │  3. 上游 429/额度错 → 标记耗尽+冷却 → 换下一个
  │     上游 401/鉴权错 → 标记停用
  │     上游 5xx/网络错 → 短时冷却
  ▼
号池 (data/accounts.json)  ← 持久化运行时状态（额度/冷却/计数）
```

流式（`stream:true`）响应会被**透明转发**，客户端无感。

## 关于「从 linux.do 找免费模型」

linux.do 上常有网友分享自己的中转站，多数**签到即送额度**。但：

- 中转站 Key 是他人资源，**请只录入你自己注册/签到的账号**，避免滥用导致封号。
- 自动抓取论坛帖子脆弱且可能违反站点条款，因此本仓库**不提供自动注册/自动签到**。
- `src/discovery/linuxdo.js` 仅作为一个**实验性辅助提取器**：给你已登录的 Cookie + 帖子链接，帮你从 HTML 里提取疑似中转域名与 Key，仍需人工核对后 `cli add` 录入。

收录账号的可靠方式：在论坛找到分享帖 → 自行去该中转站注册/签到拿 Key → `cli add`。

## 与 DeepSeek-Desktop 的集成（规划）

桌面端 `main.js` 当前会自动拉起 Harness（本地 3080）。未来可同样在启动时拉起本服务（默认 3090），并将桌面对话的 API base_url 指向它，从而实现「多免费中转站聚合 + 自动切换」的本地网关。

## 安全提示

- `data/accounts.json` 存有真实 API Key，**已被 `.gitignore` 排除，切勿提交**。
- 代理默认只监听 `127.0.0.1`；如需暴露到局域网，请自行加反向代理与鉴权（设置 `ADMIN_TOKEN` 保护 `/admin/pool`）。
