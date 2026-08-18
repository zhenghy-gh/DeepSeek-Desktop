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
| `add --base-url --api-key [--name] [--models m1,m2] [--groups g1,g2] [--weight n]` | 录入账号（可打分组标签） |
| `import --file <path> \| --url <url> [--format auto\|json\|env\|codex\|oneapi\|nextchat] [--dry-run] [--name-prefix <p>]` | 从平台导出批量导入账号 |
| `list` | 列出号池（表格） |
| `remove --id <id>` | 删除账号 |
| `enable --id <id>` / `disable --id <id>` | 启/禁用账号 |
| `edit --id <id> [--name] [--base-url] [--api-key] [--models] [--groups g1,g2] [--weight] [--cooldown-ms] [--enable\|--disable]` | 修改账号字段（含分组） |
| `status` | 号池健康概览 |
| `show --id <id>` | 查看单个账号详情（含运行时状态） |
| `export [--out <file>]` | 导出号池为 JSON（备份；不带 `--out` 输出到 stdout） |
| `validate` | 校验号池配置，列出错误与警告（退出码 1 表示有错误） |
| `serve` | 启动代理（同 `npm start`） |

配置项（环境变量）：

- `PORT`（默认 3090）、`HOST`（默认 127.0.0.1）：代理监听地址。
- `DATA_FILE`：号池文件路径（默认 `data/accounts.json`）。
- `ADMIN_TOKEN`：`/admin/pool` 与 `/metrics` 接口的保护令牌；**不设置则本地开放**（仅本机）。
- `PROXY_AUTH_TOKEN`：保护 `POST /v1/chat/completions` 与 `POST /v1/embeddings`（区别于管理端）；**不设置则代理开放**。客户端需带 `Authorization: Bearer <token>`。
- `UPSTREAM_TIMEOUT_MS`：上游请求（连接 + 读取）整体超时（默认 60000ms）。
- `CONNECT_TIMEOUT_MS`：上游**连接**建立超时（默认 8000ms），专治 DNS / TCP 握手卡死。
- `STREAM_IDLE_TIMEOUT_MS`：流式（`stream:true`）响应**空闲超时**（默认 30000ms）。上游长时间不发数据则中断，避免连接挂死占用额度。
- `MAX_CONCURRENCY_PER_ACCOUNT`：每账号**最大并发**（默认 0 = 不限）。免费账号建议设小（如 2），达上限的账号会被暂时跳过（仍有其他候选时），避免打爆单账号。
- `CONSECUTIVE_FAILURE_LIMIT`：连续错误达到该值**自动熔断禁用**该账号（默认 0 = 关闭），需手动 `enable` 恢复。
- `ALLOW_CORS`：设为 `*` 或具体源以开启 CORS（含 `OPTIONS` 预检），便于本地前端调用；留空关闭。
- `POOL_STRATEGY`：选号策略 `weighted`（默认）| `round_robin` | `least_used`。
- `ALIASES`：模型别名映射，格式 `别名:真名1,真名2;别名2:真名3`（也可改用 `config/aliases.json`）。
- `LOG_LEVEL`：日志级别 `debug|info|warn|error`（默认 `info`），日志以 JSON 行输出到 stderr，不污染代理响应。
- `LOG_FILE`（可选）：设置后日志同时写入该文件，并按大小自动轮转（`LOG_FILE_MAX_BYTES` 默认 10MB、`LOG_FILE_KEEP` 默认保留 3 份），避免长期运行撑爆磁盘。
- `MAX_REQUEST_BODY_BYTES`：代理请求体大小上限（默认 10MB）。超限返回 `413 payload_too_large`，防止超大请求撑爆内存。
- `RATE_LIMIT_RPS`：全局速率限制（每秒请求数，默认 0 = 不限）。对所有 `/v1/*` 代理请求按令牌桶限速，超限返回 `429 rate_limited`。建议配合 `RATE_LIMIT_BURST` 设突发额度。
- `RATE_LIMIT_BURST`：令牌桶容量（默认 = `RATE_LIMIT_RPS`），控制允许的瞬时突发量。
- `WATCH_CONFIG`：设为 `false` 可关闭「号池文件热重载监听」（默认开启）。

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

## 可观测性（Metrics & 日志）

代理内置轻量指标，便于长期运行与排障：

- `GET /metrics`：返回 JSON 指标（总请求 / 成功 / 失败 / 切换次数、按账号与模型的聚合、最近错误、平均延迟、运行时长）。加 `?format=prometheus` 返回 Prometheus 文本格式，可直接被 Prometheus 抓取。
- `GET /admin/pool`：号池账号详情（状态、用量、最近错误）。
- 每次请求都会输出一行结构化日志到 **stderr**：`{"ts","lvl","msg","meta":{method,path,status,ms}}`。

> 若设置了 `ADMIN_TOKEN`，`/metrics` 与 `/admin/pool` 都需带 `Authorization: Bearer <token>` 才能访问。

### 重置指标
`POST /admin/metrics/reset`（同样受 `ADMIN_TOKEN` 保护）可清零累计指标，便于长期运行后按周期重新统计。只读 Web 管理页也提供了「重置」按钮（填入令牌后可用）。

## 进阶：模型别名、选号策略、Embeddings、管理页

### 模型别名（Aliases）
不同中转站对同一模型的命名可能不同（如 `deepseek-chat` vs `DeepSeek-V3`）。配置别名后，请求写「别名」也能命中写了「真名」的账号，反之亦然（双向匹配）。

两种方式任选其一：
- 环境变量：`ALIASES="deepseek-chat:DeepSeek-V3,DeepSeek-V2.5;gpt-4o-mini:abab6.5"`
- 配置文件 `config/aliases.json`：`{ "deepseek-chat": ["DeepSeek-V3","DeepSeek-V2.5"], "gpt-4o-mini": ["abab6.5"] }`

### 选号策略（Strategy）
通过 `POOL_STRATEGY` 切换（重启生效）：
- `weighted`（默认）：连续错误少 + 最近没用过 优先，权重做随机扰动，天然负载均衡。
- `round_robin`：在候选中按顺序轮流，绝对均匀分摊。
- `least_used`：优先选累计用量最少的账号。

### Embeddings 端点
除 chat 外，也暴露 `POST /v1/embeddings`，沿用同一套号池选号 + 故障转移。请求体照 OpenAI 规范带 `model` 与 `input` 即可。

### 通用 OpenAI 兼容透传
除 chat/embeddings 外，`/v1/*` 的其余路径（如 `/v1/images/generations`、`/v1/audio/transcriptions`、`/v1/moderations`、`/v1/responses` 等）均按**原请求路径**透传，复用同一套号池选号 + 故障转移 + 流式健壮性。请求体需含 `model` 字段。

### 只读 Web 管理页
启动后访问 `http://127.0.0.1:3090/`（或 `/web`），是一个零依赖的只读页面，实时展示号池状态与运行指标；若设置了 `ADMIN_TOKEN`，在页面顶部填入令牌即可拉取受保护的数据。

### 账号分组 / 按组路由（Group Routing）
给账号打 `groups` 标签后，可在请求时通过 `group` 限定「只从这一个分组里选号」，实现「不同用途走不同账号池」。

- 录入/修改：`node src/cli.js add ... --groups premium,fast` 或 `edit --id <id> --groups free`。
- 请求时指定分组（二选一）：
  - 请求体带 `group` 字段：`{"model":"deepseek-chat","group":"premium","messages":[...]}`。
  - 或 HTTP 头：`X-LDFA-Group: premium`。
- 行为：号池只在「属于该分组且支持模型」的账号里选号；若指定分组内无可用账号，返回 `502` 并在错误信息中指明分组。不指定 `group` 则不限分组（兼容旧行为）。

### 号池管理 API（免 CLI）
除了命令行，号池也提供受 `ADMIN_TOKEN` 保护的 HTTP 管理接口，方便接入 Web 页或脚本批量管控：

| 方法 & 路径 | 说明 |
| --- | --- |
| `POST /admin/pool` | 新增账号（body：`name` / `baseUrl` / `apiKey` / `models` / `groups` / `weight`） |
| `POST /admin/pool/:id/enable` | 启用账号 |
| `POST /admin/pool/:id/disable` | 禁用账号 |
| `POST /admin/pool/:id/remove` | 删除账号 |
| `POST /admin/health-check` | 主动探活：逐个账号发 `GET /v1/models`，返回 `{ reachable, total, results }`（只报告，不改账号状态） |
| `POST /admin/reload` | 热重载号池：从磁盘重新读取 `accounts.json` 并立即生效，无需重启进程（手动触发，等价于文件监听） |

只读 Web 管理页在填入 `ADMIN_TOKEN` 后会显示「新增账号」表单、每行「启用/禁用/删除」按钮以及「一键体检」。

> 以上 `/admin/*` 接口在设置 `ADMIN_TOKEN` 后均需 `Authorization: Bearer <token>`；未设置时本地默认开放。

## Docker 部署

镜像**零依赖**，无需 `npm install`，仅用 Node 运行时。已内置 `HEALTHCHECK`（探测 `/health`）。

### 单容器

```bash
docker build -t linux-do-free-api .
# 号池数据持久化到挂载卷 /app/data
docker run -d -p 3090:3090 \
  -e ADMIN_TOKEN=你的令牌 \
  -e PROXY_AUTH_TOKEN=客户端令牌 \
  -v $(pwd)/data:/app/data \
  linux-do-free-api
```

### docker compose（推荐）

仓库已提供 `docker-compose.yml`，可直接用环境变量文件驱动：

```bash
cp .env.example .env   # 按需填写令牌与策略
docker compose up -d
# 可选：带本地 Prometheus 监控（抓取 /metrics?format=prometheus）
docker compose --profile monitoring up -d
```

> 所有可配置项见 `.env.example`；`config/aliases.example.json` 给出模型别名配置样例。

### 健康检查

容器自带健康检查，也可手动验证：

```bash
curl http://127.0.0.1:3090/health
# {"ok":true,"accounts":N,"models":M,"uptimeSec":...,"failures":0,"adminProtected":true,"proxyProtected":true}
```

## 近期增强（生产加固）

- **代理端鉴权**：新增 `PROXY_AUTH_TOKEN`，独立于 `ADMIN_TOKEN` 保护 `/v1/chat/completions` 与 `/v1/embeddings`，防止代理被滥用。
- **延迟分位数指标**：`/metrics` 新增 `p50/p95/p99` 延迟与直方图（含 Prometheus histogram/summary），排障更直观。
- **每账号并发限流**：`MAX_CONCURRENCY_PER_ACCOUNT` 超限账号自动去优先级（仍有候选时），避免打爆单个免费账号；指标记录 `concurrency_limited`。
- **自适应冷却 + 熔断**：瞬态错误冷却随连续错误指数退避（封顶 1h）；`CONSECUTIVE_FAILURE_LIMIT` 达阈值自动禁用（熔断）坏账号，指标记录 `circuit_opened`。
- **原子持久化**：号池保存改为「临时文件 + rename」，避免并发保存或崩溃损坏 `accounts.json`。
- **流式健壮性**：每个响应带 `X-Request-Id` 便于追踪；客户端断开即销毁上游；流式空闲超时（`STREAM_IDLE_TIMEOUT_MS`）防止挂死。
- **请求校验与错误信封**：chat 缺 `messages`、embeddings 缺 `input` 直接 `400`；错误响应统一带回 `type` 字段。
- **CORS**：`ALLOW_CORS` 开启跨域与 `OPTIONS` 预检，方便本地前端接入。
- **优雅退出**：`SIGTERM/SIGINT` 停止接收新连接、等待在途请求结束后退出，避免中断进行中的请求。
- **Web 管理页增强**：新增 KPI 概要（成功率 / p95 / 并发跳过 / 熔断 / 运行时长）、模型数与最后错误时间列。
- **配置热重载**：监听 `data/accounts.json` 变更（去抖并忽略自身写入），外部编辑后**无需重启**自动生效；另提供 `POST /admin/reload` 手动触发。
- **请求体大小限制**：`MAX_REQUEST_BODY_BYTES` 超限返回 `413`，防御大请求。
- **错误分类增强**：识别上下文/Token 长度超限（`context_length`），不再误判为瞬态错误去切换账号。
- **全局速率限制**：`RATE_LIMIT_RPS` + `RATE_LIMIT_BURST` 令牌桶，超限 `429 rate_limited`，防止代理被刷爆。
- **流式中间错误修复**：流式响应中途上游断流时，未发头返回 `502`、已在流中则补发 SSE 错误事件再结束，避免客户端收到截断流。
- **Web 页代理连通性测试**：新增 `PROXY_AUTH_TOKEN` 输入框与「发送测试请求」按钮，直接在页面验证代理链路。
- **Token 用量统计与成本估算**：自动从响应 `usage` 解析（非流式精确、流式 SSE 最佳努力扫描）；按账号累计 `prompt/completion/total tokens`，指标暴露 `totalTokens` 与 `estimatedCostUsd`；可选 `config/prices.json` 提供价格表后自动估算成本（USD）。CLI `show` 与 Web 页均展示。
- **备份 / 恢复**：`GET /admin/backup` 下载号池 JSON（受 `ADMIN_TOKEN` 保护）；`POST /admin/restore` 上传 JSON 数组整体替换号池；CLI `export` / `restore --file` 本地备份与恢复。
- **账号软删除**：`remove` 默认软删除（标记为 `removed`，隐藏且保留，可 `restore` 恢复）；`purge` 彻底删除（不可恢复）；避免误删丢失号池数据。Web 页新增「彻底删」按钮。
- **请求审计日志 + 头部透传 + CORS 增强**：代理请求/响应均记录 `model`/`account`/`ok`/`status` 审计轨迹；白名单上游头部透传（`OpenAI-Organization`/`X-*` 等，不覆盖本地鉴权）；CORS 增加 `Allow-Credentials` 与 `Vary: Origin`。
- **CLI 批量操作**：`enable`/`disable`/`remove`/`purge`/`restore` 支持 `--all` 与 `--group <g>`；`list`/`stats` 支持 `--group` 过滤；新增 `stats` 汇总（状态分布 / Token / 分组）。
- **模型级权重 `modelWeights`**：账号可对特定模型单独设权重（如 `{"gpt-4o":3}`），`weighted` 策略命中时优先，实现热门模型偏好高配账号。
- **通用编辑端点 `POST /admin/pool/:id/edit`**（受 `ADMIN_TOKEN` 保护）：改 `models/groups/weight/modelWeights/note`；CLI `edit` 支持 `--note` 与 `--model-weights`。
- **Web 页 inline 编辑**：每行「编辑」展开表单即时改字段；账号备注 `note` 贯穿展示与导出。
- **探活自动下线**：`POST /admin/health-check` 支持 `autoDisable:true`，将不可达账号自动置为 disabled（默认仅报告不改状态）；Web 页体检增加「不可达自动下线」勾选。

## 测试

```bash
npm test          # 运行单元测试（node:test）+ 故障转移冒烟测试
node --test test/*.test.mjs   # 仅单元
node test/smoke.mjs           # 仅冒烟（双 mock 上游验证 failover）
```

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

## Cookbook & FAQ

常见调用示例（curl）见 [`examples/curl.md`](examples/curl.md)：添加账号、对话、流式、Embeddings、通用 `/v1/*` 透传、指标、探活、备份恢复、CLI 批量管理。

**Q：如何只让某类请求走特定账号？**
A：给账号打 `groups`，请求时通过 `group` 字段或 `X-LDFA-Group` 头限定分组（见迭代 4 / 分组路由）。

**Q：免费账号额度用完了怎么办？**
A：接口返回 429/额度耗尽时，代理自动将该账号标记为 `exhausted` 并冷却，冷却结束自动复活；也可 `cli disable --group xxx` 手动隔离。

**Q：如何估算花费？**
A：在 `config/prices.json` 提供每 1k token 价格（参考 `config/prices.example.json`），代理会从响应 `usage` 自动累计 Token 与估算成本（`metrics` 的 `estimatedCostUsd`）。

**Q：生产部署？**
A：`docker compose up -d` 即可；`docker-compose.yml` 已含健康检查与可选 Prometheus profile，`deploy/prometheus.yml` 提供抓取配置。

**Q：改动号池需要重启吗？**
A：不需要。编辑 `data/accounts.json` 会被自动热重载（`WATCH_CONFIG`，默认开），也可 `POST /admin/reload` 手动触发。
