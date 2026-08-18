# 增量改进路线图（ROADMAP）

> 本文件是 `linux-do-free-api` 的持续迭代基线。当前为 MVP 已上线私密仓库后的改进规划。
> 工作流遵循「需求(PRD) → 设计 → 实现 → 测试」分阶段推进；由于会话内团队编排工具受限，阶段产出由主理人直接落地。

## 改进愿景

把「能跑的 MVP 号池代理」打磨成**生产可用、好观测、好运维**的工具：出事前能看到指标、出事后能快速定位、加账号/导入/部署都顺手。

## 已完成（第 1 轮，2026-08-17）

- ✅ 内存指标模块 `src/metrics.js`：请求数/成功/失败/切换、按账号与模型聚合、最近错误、Prometheus 文本导出。
- ✅ 结构化日志 `src/logger.js`（JSON 行到 stderr，受 `LOG_LEVEL` 控制）。
- ✅ `/metrics` 端点（JSON 默认；`?format=prometheus` 输出 Prometheus 格式），与 `/admin/pool` 统一受 `ADMIN_TOKEN` 保护。
- ✅ 请求级日志（方法 / 路径 / 状态码 / 耗时）。
- ✅ `router.js` 注入可测的 `forward`，接入指标与日志；新增切换计数。
- ✅ `cli.js` 新增 `edit` 命令（改 name/baseUrl/apiKey/models/weight/cooldown/启用禁用）。
- ✅ 单元测试：`account` / `pool` / `errors` / `router`（含故障转移、全失败 502、client_error 不切换）。
- ✅ `Dockerfile` + `.dockerignore`（零依赖，仅运行时不需 npm install）。
- ✅ `UPSTREAM_TIMEOUT_MS` 透传（上游超时可由环境变量调节）。

## 已完成（第 2 轮，2026-08-17）

- ✅ **P0-1 超时细化 + 瞬态退避重试**：`upstream.js` 拆分「连接超时 `CONNECT_TIMEOUT_MS`」与「整体超时 `UPSTREAM_TIMEOUT_MS`」；`router.js` 抽象 `handleWithFailover`，对瞬态错误（网络/5xx，含连接超时）在同一账号上做有限次指数退避重试（`maxPerAccountRetries`，默认 1），重试耗尽才切换到下一个账号。`metrics` 增加 `totalRetries` / `retries` 计数。
- ✅ **P0-2 配置校验**：`Store.validate()` 返回可读问题（非法 `baseUrl` 为 error，空 `apiKey` 为 warning）；`serve` 启动时打印，`cli validate` 可主动检查（有 error 时退出码 1）。
- ✅ **P0-3 CLI 增强**：`export [--out <file>]` 导出号池 JSON（备份），`show --id <id>` 查看账号详情（含运行时状态）。

## 已完成（第 3 轮，2026-08-17）

- ✅ **P1-1 模型别名**：`AccountPool` 支持别名映射（请求别名↔真名双向命中），来源 `ALIASES` 环境变量或 `config/aliases.json`。
- ✅ **P1-3 选号策略可配**：`POOL_STRATEGY` = `weighted`（默认）/ `round_robin` / `least_used`。
- ✅ **P1-4 embeddings 端点**：`POST /v1/embeddings` 复用故障转移，`upstream` 用 `pathOverride` 转发到 `/v1/embeddings`。
- ✅ **P1-5 只读 Web 管理页**：`web/index.html` 零依赖静态页（拉 `/admin/pool` 与 `/metrics`），`server` 托管 `GET /` 与 `/web`。
- ✅ **P2-1 CI**：`.github/workflows/test.yml` 在 Node 18/20/22 矩阵上跑 `npm test`。

## 已完成（第 4 轮，2026-08-17）

- ✅ **P1-2 账号分组 / 按组路由**：账号新增 `groups` 标签；`pool.candidatesForModel/select` 支持 `group` 过滤；请求可通过 `payload.group` 或 `X-LDFA-Group` 头限定分组；CLI `add`/`edit` 支持 `--groups`；Web 页展示分组列。组内无可用账号时返回带分组信息的 502。
- ✅ **P2-2 指标重置 + 日志轮转**：新增 `POST /admin/metrics/reset`（受 `ADMIN_TOKEN` 保护，Web 页有「重置」按钮）清零累计指标；`logger` 支持 `LOG_FILE` 按大小轮转（`LOG_FILE_MAX_BYTES` / `LOG_FILE_KEEP`）。

## 已完成（第 5 轮，2026-08-17）

- ✅ **号池管理 HTTP API**：`POST /admin/pool`（增）、`POST /admin/pool/:id/(enable|disable|remove)`（改/删），均受 `ADMIN_TOKEN` 保护；只读 Web 页升级为可管理页（新增账号表单 + 每行启用/禁用/删除按钮）。
- ✅ **主动探活**：新增 `src/probe.js` 与 `POST /admin/health-check`，逐个账号发 `GET /v1/models` 报告可达性（只报告不改状态），Web 页提供「一键体检」。
- ✅ **测试补全**：新增 `test/probe.test.mjs`（探活，mock fetch）、`test/server.test.mjs`（管理 API + 探活接口端到端）。

## 已完成（第 6 轮，2026-08-17）

本轮聚焦「部署易用性 + 生产加固」，零依赖前提下补齐 9 项：

- ✅ **部署易用性**：`Dockerfile` 升级 `node:20-alpine` + `HEALTHCHECK`（探 `/health`）+ 预建 `/app/data`；新增 `docker-compose.yml`（含 healthcheck / restart / 可选 Prometheus profile）、`.env.example`、`config/aliases.example.json`、`deploy/prometheus.yml`；`index.js` 优雅退出（`SIGTERM/SIGINT` 停止接收新连接、等待在途请求、flush 日志）。
- ✅ **代理端鉴权 `PROXY_AUTH_TOKEN`**：独立于 `ADMIN_TOKEN` 保护 `/v1/chat/completions` 与 `/v1/embeddings`，防代理被滥用（管理端仍由 `ADMIN_TOKEN` 保护）。
- ✅ **延迟分位数指标**：`metrics` 增加延迟直方图，`/metrics` 暴露 `p50/p95/p99` 与 `maxLatencyMs`，Prometheus 增加 histogram + summary。
- ✅ **流式健壮性**：响应统一带 `X-Request-Id`；客户端断开（`req close`）即销毁上游；流式空闲超时 `STREAM_IDLE_TIMEOUT_MS` 中断挂死连接。
- ✅ **每账号并发限流 `MAX_CONCURRENCY_PER_ACCOUNT`**：达上限账号自动去优先级（仍有候选时），指标记录 `concurrency_limited`。
- ✅ **自适应冷却 + 熔断 `CONSECUTIVE_FAILURE_LIMIT`**：瞬态冷却随连续错误指数退避（封顶 1h）；连续错误达阈值自动禁用坏账号，指标记录 `circuit_opened`。
- ✅ **原子持久化**：`store.save` 改为临时文件 + `rename`，避免并发/崩溃损坏 `accounts.json`。
- ✅ **请求校验与错误信封**：chat 缺 `messages` / embeddings 缺 `input` → `400 bad_request`；错误响应统一带回 `type`。
- ✅ **CORS `ALLOW_CORS`**：开启跨域与 `OPTIONS` 预检，便于本地前端调用。
- ✅ **Web 管理页增强**：KPI 概要（成功率 / p95 / 并发跳过 / 熔断 / 运行时长）、模型数、最后错误时间列、代理鉴权提示。

## 已完成（第 7 轮，2026-08-17）

本轮聚焦「稳定性 + 易用性 + 可观测性」，零依赖前提下补齐 7 项：

- ✅ **配置热重载**：`index.js` 用 `fs.watchFile` 监听 `DATA_FILE`，去抖（300ms）并忽略自身 `save` 写入（基于 `store.lastSaveAt`）；外部编辑后**无需重启**即生效；`server` 新增 `POST /admin/reload` 手动触发（受 `ADMIN_TOKEN` 保护）。`WATCH_CONFIG=false` 可关闭。
- ✅ **请求体大小限制**：`MAX_REQUEST_BODY_BYTES`（默认 10MB），超限返回 `413 payload_too_large`（用 `req.pause()` 而非 `destroy`，确保响应稳定写回）。
- ✅ **错误分类增强**：`errors.js` 新增 `context_length` 类型（识别上下文/Token 长度超限），`router` 将其与 `client_error` 同样处理——不切换账号、直接返回上游状态码，避免误判瞬态去切号。
- ✅ **全局速率限制**：`RATE_LIMIT_RPS` + `RATE_LIMIT_BURST` 令牌桶，对所有 `/v1/*` 代理请求限速，超限 `429 rate_limited`；`metrics` 增加 `totalRateLimited`（含 Prometheus 导出）。
- ✅ **流式中间错误修复**：`pipeUpstream` 在流式响应中途上游断流时，未发头 → `502` JSON；已在 SSE 流中 → 补发 `data: {error}` 事件再结束，避免客户端收到截断流；流式空闲超时（504）同理。
- ✅ **Web 页代理连通性测试**：新增 `PROXY_AUTH_TOKEN` 输入框与「发送测试请求」按钮，直接在页面发最小 chat 请求验证 `/v1/chat/completions` 链路。
- ✅ **测试补全**：新增 `context_length` 分类测试、`413` 超限测试、`429` 限速测试、`/admin/reload` 测试；单测累计 **58 个** + 冒烟全过。

## 剩余待做（P2）

| 编号 | 改进项 | 动机 | 验收标准 | 预估文件 |
| --- | --- | --- | --- | --- |
| P2-3 | 与桌面端 DeepSeek-Desktop 集成 | 桌面端对话直接走号池 | 启动时拉起 + base_url 指向 3090 | 上级仓库 main.js（用户暂缓） |
| P2-4 | 每日签到自动化（各中转站单独实现） | 自动领额度 | 可插拔的签到适配器 | src/sign/（涉及各站单独适配，可能违反其服务条款） |

## 已完成（第 8 轮，2026-08-17）

- ✅ **模型级权重 `modelWeights`**：账号可对特定模型单独设权重（命中时覆盖账号级 `weight`），`weighted` 策略自动采用。
- ✅ **通用编辑端点 `POST /admin/pool/:id/edit`**（受 `ADMIN_TOKEN` 保护）：改 `models/groups/weight/modelWeights/note`；CLI `edit` 新增 `--note` 与 `--model-weights`。
- ✅ **Web 页 inline 编辑**：每行「编辑」展开表单（模型/分组/权重/备注/模型级权重），保存即生效。
- ✅ **账号备注 `note`**：贯穿号池展示与导出。
- ✅ **测试**：新增 modelWeights/note 保留、summary 含字段、edit 端点用例；单测累计 **60 个** + 冒烟全过。

## 已完成（第 9 轮，2026-08-17）

- ✅ **探活自动下线开关**：`POST /admin/health-check` 增加 `autoDisable:true` 参数，将对不可达账号自动置 `disabled`（默认仅报告不改状态，避免误杀）；返回 `autoDisabled` 列表。
- ✅ **Web 页体检增强**：增加「不可达自动下线」勾选，体验闭环。
- ✅ **测试**：新增 autoDisable 端到端用例；单测累计 **61 个** + 冒烟全过。

## 已完成（第 10 轮，2026-08-17）

- ✅ **通用 OpenAI 兼容透传**：`/v1/*` 其余路径（images/audio/moderations/responses 等）按原请求路径透传，复用号池选号 + 故障转移 + 流式健壮性；请求体需含 `model`。
- ✅ **测试**：新增通用透传用例（验证 `apiPath` 透传原始路径）；单测累计 **62 个** + 冒烟全过。

## 已完成（第 11 轮，2026-08-17）

- ✅ **Token 用量统计**：从响应 `usage` 解析（非流式精确缓冲、流式 SSE 逐块扫描最佳努力）；按账号累计 `prompt/completion/total tokens`，指标暴露 `totalTokens` 与 `estimatedCostUsd`；可选 `config/prices.json` 价格表自动估算成本（USD）。
- ✅ **Web 页增强**：KPI 增加「总Token / 估算成本」，号池表增加 Token 列。
- ✅ **测试**：新增 `recordTokens` 成本用例、Token 采集集成测试（真实上游回 usage）；单测累计 **64 个** + 冒烟全过。
- ⚠️ 修复：非流式分支此前误与 pipe 重复写回导致响应体重复，已改为仅非流式手动写回。

## 已完成（第 12 轮，2026-08-17）

- ✅ **备份 / 恢复**：`GET /admin/backup` 下载号池 JSON（受 `ADMIN_TOKEN` 保护，带 `Content-Disposition` 附件）；`POST /admin/restore` 上传 JSON 数组整体替换号池（含规范化与 id 去重、非法输入 400）；CLI 新增 `restore --file`（本地整体恢复），`export` 仍用于本地备份。
- ✅ **测试**：新增备份/恢复端到端用例；单测累计 **65 个** + 冒烟全过。

## 已完成（第 13 轮，2026-08-17）

- ✅ **账号软删除**：`remove` 默认软删除（标记 `removed`，隐藏且保留，可 `restore` 恢复）；新增 `purge` 彻底删除（不可恢复）、`restore` 恢复；号池选号与概览自动排除 `removed` 账号。`store` 增加 `purge/restore`；CLI 增加 `purge`/`restore`；Web 页新增「彻底删」按钮。
- ✅ **测试**：新增软删除/恢复/purge 端到端用例；单测累计 **66 个** + 冒烟全过。

## 已完成（第 14 轮，2026-08-17）

- ✅ **请求审计日志**：代理请求与结果均记录 `model`/`account`/`ok`/`status`/`requestId` 轨迹（结构化 JSON 日志），便于事后追查哪个账号处理了哪次请求。
- ✅ **头部透传**：白名单客户端头（`OpenAI-Organization`、`OpenAI-Beta`、`X-*`）透传到上游，但不覆盖本地 `Authorization`/`Content-Type`；新增 `test/upstream.test.mjs`。
- ✅ **CORS 增强**：增加 `Access-Control-Allow-Credentials: true` 与 `Vary: Origin`，便于带凭据的前端接入。
- ✅ **测试**：新增头部透传用例 + upstream 过滤用例 + CORS credentials 用例；单测累计 **68 个** + 冒烟全过。

## 已完成（第 15 轮，2026-08-17）

- ✅ **CLI 批量操作**：`enable`/`disable`/`remove`/`purge`/`restore` 支持 `--all` 与 `--group <g>`（按分组批量管理）；`list`/`stats` 支持 `--group` 过滤；新增 `stats` 命令汇总账号状态分布、软删除数、累计 Token 与分组分布。
- ✅ 已用临时号池实测批量禁用/恢复/统计与分组过滤均正常。

## 已完成（第 16 轮，2026-08-17）

- ✅ **文档 cookbook + examples**：新增 `examples/curl.md`（添加账号 / 对话 / 流式 / Embeddings / 通用透传 / 指标 / 探活 / 备份恢复 / CLI 批量）；README 增加 Cookbook & FAQ（分组路由、额度耗尽、成本估算、部署、热重载等高频问题）。

## 待确认问题（需用户拍板）

1. ~~是否需要 Web 管理页？~~ → **已做（只读页，含指标重置按钮）**。
2. ~~是否要支持 chat 之外的端点（embeddings）？~~ → **已做**。
3. 桌面端集成现在做，还是先停在独立服务？→ **用户暂缓，先独立**。
4. 是否需要真实「每日签到」自动化（涉及各中转站单独适配，且可能违反其服务条款）？

> 注：第 1~16 轮累计单测 **68 个** + 冒烟测试，全部通过；已提交并推送至私密仓库 `zhenghy-gh/linux-do-free-api`。

## 后续可选项（规划中）

- ✅ ~~配置热加载~~ → **已做（第 7 轮：号池文件热重载 + /admin/reload 手动触发）**。
- **模型级别权重**：不同模型可设不同优先级/权重，而非仅账号级 `weight`。
- **探活自动改状态（可选）**：在「只报告」之外提供「自动下线不可达账号」开关（需谨慎，避免误杀）。
- **Web 页编辑账号字段**：当前仅支持新增/启用/禁用/删除，未来可 inline 编辑 `models/groups/weight`。
