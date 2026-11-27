# OpenTag 的 BeFreed 分叉

> Canonical source: [BEFREED.md](./BEFREED.md)
> Last synced with: 2026-11-27

本仓库是 `BeFreed-ai/opentag`，即 `first-tree-ai/opentag`（Apache-2.0）的分叉。它**不是**上游正式发布版，也不得以上游产品的名义呈现（见 `NOTICE`）。我们的工作绝不在上游仓库开 PR、issue 或评论；所有改动先落在本仓库。

基线：上游标签 `v0.1.5`（`606a58b05541b0c4073b157374d05771f3d6fb4e`）。发布线是分支 `befreed/release-0.1.4`（名字是历史遗留，内容是 v0.1.5 加下面的补丁）。不要从 `main` 构建：它远落后于上游，不是部署基线。

## 我们相对上游 v0.1.5 的补丁

每个补丁都很小，默认关闭或仅做诊断。到 `0.1.5-befreed.4` 为止都没有新增数据库迁移；**`0.1.5-befreed.5` 新增了一个**（`0073_agent_schedules_fresh_session`），见部署手册。

| # | 范围 | 文件 | 目的 | 默认 |
|---|------|------|------|------|
| C1 | 客户端 | `packages/client/src/runtime/session-message-inbox.ts`、`agent-turn-runner.ts`、新增 `provider-launch-configuration.ts`（含测试） | 定时（session-message）回合拿到服务器授予的 MCP 网关和网页工具 | 开 |
| C2 | 客户端 | `packages/client/src/runtime/context-tree-command-diagnostics.ts`、`context-tree-commands.ts`（含测试） | 记录 Context Tree 网关失败（仅诊断） | 开 |
| C3 | 客户端构建 | `scripts/befreed/set-fork-version.mjs`、`scripts/portable/build-portable.mjs` | 允许 `<稳定版>-befreed.<n>` 版本标签 | 不适用 |
| C4 | CI | `.github/workflows/befreed-client-release.yml`、`befreed-upstream-sync.yml` | 分叉客户端发布；每周在分叉内开"上游有新内容"的提醒 PR | 手动 / 每周 |
| S1 | 服务器构建 | `.github/workflows/befreed-server-image.yml` | 上游 `docker.yml` 只在上游仓库运行；本流水线用同一个 Dockerfile（`runtime` 目标）构建并推到我们自己的私有 ECR 仓库（2026-11 之前是私有 GHCR 包） | 手动 |
| S2 | 服务器 | 新增 `packages/server/src/services/schedules/operator-service.ts`、`packages/server/src/api/operator-schedules.ts`、`packages/server/src/operator-routes-config.ts`；接线在 `packages/server/src/app.ts`（+8 行）和 `packages/server/src/index.ts`（+9 行） | 运营专用的账号级路由：为 agent 创建定时任务，无需入站 IM 消息（cron、一次性 `at`、或"N 秒后运行"） | **关** |
| S3 | 服务器测试 | `packages/server/src/__tests__/operator-schedule-api.test.ts`、`operator-routes-config.test.ts`、`__tests__/integration/operator-schedules.test.ts` | S2 的测试 | 不适用 |
| S4 | 服务器 | 新增 `packages/server/src/runtime-credentials/gateway-principal.ts`；在 `services/mcp/mcp-gateway-service.ts`、`mcp-gateway-upstream.ts`、`mcp-transport.ts`、`mcp-auth-headers.ts`、`api/mcp-gateway.ts` 和 `index.ts`（+5 行）里加少量接线（含测试） | 对标记为"需要主体"的 MCP 服务器，在网关发出的 `tools/call` 请求上签名"是谁触发了这次执行"（真人 / 定时任务 / agent / 系统），让对方服务器能验证调用方，而不是信任网络。同时为每次网关工具调用写一行结构化日志 | **关**（只有额外请求头含 `x-opentag-principal: required` 的服务器才生效） |

S2 复用上游代码处理所有规则：`ScheduleService.createForAgent` 校验 cron 语法、时区、未来触发时间、提示词大小（16 KiB）并写入记录、版本号和审计事件；`SessionService.ensureChatSession` 查找或创建目标会话，并要求 agent 处于活跃状态且已绑定机器。S2 只是在调用方通过鉴权、运营白名单和归属检查之后，构造上游通常从 agent 的会话证明里推导出的"范围"。它从不读取或伪造会话证明。

### S2 做什么、不做什么

- 路由：`POST /api/v1/operator/agents/:agentId/schedules`。仅当 `OPENTAG_OPERATOR_ROUTES_ENABLED=true` 时注册；否则该路径不存在（404，和任何未知路径一样）。
- 检查顺序：平台账号的 Bearer 令牌（拒绝 cookie 会话）-> 用户 id 必须在 `OPENTAG_OPERATOR_USER_IDS` 中（否则在读取请求体之前返回 403 `AGENT_FORBIDDEN`）-> 严格的请求体校验（400）-> agent 必须属于调用账号且未删除（否则 404，与账号侧列表/查看路由的隐藏方式一致）-> agent 需要有活跃的 IM 绑定（409 `SCHEDULE_TARGET_REQUIRED`），且 agent 活跃并绑定了机器（409 `SCHEDULE_TARGET_INVALID`）。
- 它仍然需要 agent 已有 IM 绑定（Slack 或飞书）：会话总是挂在绑定上。它去掉的是"需要有人先发第一条消息"，不是"需要绑定"。
- 请求体：`channelId`、`conversationKind`（`channel|dm|group_dm`）、`name`、`prompt`，再加 `schedule`（`cron`、`at` 或 `every`）和 `timezone`，或者 `runInSeconds`（5..3600，按服务器数据库时钟计算，一次性，不能与 `enabled:false` 同用），以及可选的 `enabled`（默认 true；false 则创建后为暂停状态）。
- 只创建。列出、读取、暂停、恢复、删除都用现有账号路由（`GET/POST/DELETE /api/v1/agents/:agentId/schedules...`）。
- 审计：每次调用一行结构化日志（`operator.schedule.created|denied|failed`），含运营者用户 id、agent id、定时任务 id 和规则类型；绝不含提示词、令牌或任何请求头。上游自己的 `schedule.created` 事件也会记录。该日志不是持久审计链，持久审计请继续用 Host 侧的审计链。
- 代某位 Slack 真人创建（可选 `onBehalfOf: {"slackUserId": "U..."}`）：服务器为任务记录来源，使定时任务的运行能取得 GitHub 凭证和 Context Tree 同步。调用方不能自己传 delivery id；服务器自己在该 agent 绑定的这个频道会话里，查找该 Slack 用户最近一条已被接受的真人入站消息，并把它记为来源。找不到、是机器人、是该 agent 自己的机器人、或不是 Slack 绑定，一律 409 `SCHEDULE_ON_BEHALF_NOT_VERIFIED`，绝不降级为无来源。证明依据是"该用户在此频道发过话且被接受"，不是实时的 Slack 成员查询（已退出频道的人仍可通过；从没发过话的成员会 409）。不带 `onBehalfOf` 时行为不变（无来源）。日志行同时带 `onBehalfOfSlackUserId`。凭证作用域不变（仅该 agent 已绑定的仓库）。
- 已知限制：规则校验失败的请求（例如 cron 写错）可能留下一个空的频道会话（无害，下次同频道调用会复用）。`enabled:false` 是两步（先创建再暂停），所以马上到点的任务理论上可能运行一次；不要把它和马上触发的 `at` 一起用。
- 拒绝 cookie 会话是防御性的第二道检查；见 PR 中的"未验证"一节。

### S4：网关工具调用上的签名主体

**按 MCP 服务器逐个开启**：在服务器定义（或某个 agent 的覆盖）里加一个额外请求头 `x-opentag-principal: required`（名字不区分大小写，值必须正好是 `required`）。这个标记是配置，不是要发出去的东西：它会从所有出站请求头里删掉（探测请求也一样），然后由签名器设置一个同名请求头，里面是签名后的声明。标记的值如果是别的（例如 `true`），调用会直接失败（失败即关闭），而不是被忽略，免得一个笔误悄悄把保护关掉。没有标记的服务器收到的请求与以前逐字节相同。

对标记过的服务器，每个 `tools/call` 请求带四个请求头（`X-Opentag-Principal`、`-Key`、`-Timestamp`、`-Signature`）：base64url 的 JSON 声明（account、agent、execution、每次新生成的 `call` uuid、tool、`iat` 和 `principal`）、密钥 id、时间戳，以及 `v1=` 加上对 `keyId.timestamp.principalB64.sha256(请求体原始字节)` 的小写十六进制 HMAC-SHA256。哈希在传输层（`mcp-transport.ts` 的 `applyBodySignature`）对交给 fetcher 的那个字符串计算，所以就是线上实际发送的字节；协议版本重试的请求体不同，会用自己的 `call` id 重新签名。只签 `tools/call`（不签 `initialize`、通知、`tools/list` 和探测）。

`principal` 只由执行记录和现有数据表推导（`derivePrincipal`）：delivery 对应写下该消息的真人（作者是机器人或系统则为 `unknown`），定时的 session 消息对应 `scheduled`，创建者从它记录的任务来源里解析，agent 发来的 session 消息对应 `agent`，validation 对应 `system`，其余情况或任何查询失败都是 `unknown`。它从不抛错。

密钥：`OPENTAG_GATEWAY_PRINCIPAL_KEYS`（JSON 对象，密钥 id 对应密钥；每个密钥至少 32 字节，按其 UTF-8 字节使用；密钥 id 为 1-64 个 `A-Za-z0-9_-` 字符）和 `OPENTAG_GATEWAY_PRINCIPAL_KEY_ID`（用哪个 id 签名）。两个都不设表示没有密钥：服务器照常启动，对标记服务器的每次调用都以固定错误失败（失败即关闭），不会向上游发任何东西，也绝不会不签名发送。只设了一半或格式错误会让服务器在启动时停止。轮换方式：两边都加上新密钥，切换 `KEY_ID`，再在验证方删除旧密钥。

每次网关 `tools/call` 写一行结构化日志（`MCP_GATEWAY_TOOL_CALL`）：account、agent、execution、call id、服务器名、工具名、结果、耗时、主体类型、是否已签名。绝不含请求头、密钥、工具参数，也不含主体的用户、团队或频道 id。

## 镜像构建与发布（S1）

镜像仓库：BeFreed 的 AWS 账号里的**私有 ECR 仓库 `opentag-server`**（由 BeFreed 内部维护的一个 CloudFormation 栈创建）。工作流用 GitHub 的短期 OIDC 凭据登录 AWS（一个只信任本仓库和发布分支、只能往这一个仓库推镜像的角色）：GitHub 里不存任何密钥或令牌。唯一的设置是不含机密的仓库变量 `OPENTAG_ECR_PUSH_ROLE_ARN`。版本 `0.1.5-befreed.1`、`.3`、`.4`、`.5` 发布在 `ghcr.io/befreed-ai/opentag`（私有），留在原处（`.2` 只有客户端发布，没有服务器镜像）。

标签格式：`<上游版本>-befreed.<n>`，例如 `0.1.5-befreed.1`。基础版本必须等于源码的上游版本（`apps/cli/package.json`）；`n` 绝不重用（镜像标签或 git 标签 `befreed-server-v<version>` 已存在时运行会拒绝）。git 标签记录确切的源码 SHA。

```bash
gh workflow run "BeFreed server image" --repo BeFreed-ai/opentag --ref befreed/release-0.1.4 \
  -f version=0.1.5-befreed.1 -f ref=<我们的发布分支或 SHA>
gh run watch --repo BeFreed-ai/opentag
```

一次性操作，由 AWS 账号的所有者完成：部署那个镜像仓库栈（需要本仓库和发布分支的数字 ID，步骤在 BeFreed 的内部手册里），然后设置仓库变量：`gh variable set OPENTAG_ECR_PUSH_ROLE_ARN --repo BeFreed-ai/opentag --body <PushRoleArn 输出>`。服务器用自己的实例角色从 ECR 拉取（栈会给它附加一条只读策略）：机器上不存任何凭据；部署时用该角色在拉取期间临时登录 ECR，随后登出。

**必须从发布分支派发这个工作流**（`--ref befreed/release-0.1.4`，如上）。AWS 登录只信任该分支；`-f ref=` 只决定检出和构建什么，不会改变工作流从哪个分支运行。从别的分支（例如默认分支）运行，登录会以 `Not authorized to perform sts:AssumeRoleWithWebIdentity` 失败。登录之后的每个步骤（包括测试步骤）都能看到推送角色的短期凭据；这个工作流是手动的，只有有写权限的人能运行，而该角色只能往一个仓库推送新的、不可改写的标签。

**本仓库及其镜像是公开的（它是公开仓库的分叉）。** 不得在这里提交密钥、客户数据、内部标识（账号 ID、实例 ID、桶名）或私有代码。2026-11-19 对镜像 `.1`、`.3`、`.4`、`.5` 以及本分叉里上游没有的每个提交做过审计，没有发现。

平台：只构建 `linux/amd64`（OpenTag 主机是 x86_64）。关闭了 provenance 和 SBOM 证明，使标签是单平台的普通清单。需要逐字节确定时按摘要（digest）固定；工作流摘要里会打印它。

## 部署手册（EC2 + docker compose）与回滚

**请使用 BeFreed 的内部服务器发布工具，并先读它的手册。** 它会跑检查闸门、做快照和备份、换镜像、验证，失败时把旧镜像放回去。下面手敲的步骤是手动备用方案；如果在 `docker login` 之后某条命令失败，也请执行 `docker logout <ecr registry>`，避免 ECR 登录留在 `~/.docker/config.json` 里。

前提：不要在每日 SEO 整轮期间做（重启会切断正在运行的 agent 回合，且服务器是单实例）；先做新的 EBS 快照和新的 `pg_dump`（与 0.1.5 升级时相同）；上面的镜像已存在且主机能拉取。**换之前先数迁移**：`0.1.5-befreed.1`、`.3`、`.4` 有 73 个迁移文件，`0.1.5-befreed.5` 有 74 个（`0073_agent_schedules_fresh_session`），所以这里以前说的“我们的补丁不新增迁移”已经不成立。换到迁移数与数据库相同的镜像是对称的，回滚就是改回一行；镜像迁移更多（或者数据库比要回到的镜像更新）则不对称：上游迁移不会随镜像回滚，撤销一次迁移意味着恢复变更前的备份。

在主机上（以拥有 `/opt/opentag` 的用户），尖括号为占位符：

```bash
cd /opt/opentag
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"                 # 留好；里面有旧的镜像行
grep '^OPENTAG_IMAGE=' .env                               # 记下当前值 = 回滚目标
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ecr registry>   # 主机的实例角色；不存任何凭据
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=<ecr registry>/opentag-server:<version>|' .env
docker compose pull opentag && docker compose up -d       # 服务名以 docker-compose.yml 中的为准
docker logout <ecr registry>
docker compose ps                                         # opentag 健康（镜像带 /healthz 健康检查）
curl -fsS http://127.0.0.1:8000/healthz
```

回滚，前提是旧镜像和数据库的迁移数相同（见上；否则恢复变更前的备份也是回滚的一部分）。上一个版本通常还留在主机上，而私有的 GHCR 名字没有登录就拉不下来，所以不要拉取：

```bash
cd /opt/opentag
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=<你记下的旧值，例如 ghcr.io/befreed-ai/opentag:0.1.5-befreed.5>|' .env
docker compose up -d --pull never
```

换镜像后验证：`GET /healthz` 为 200；Web 应用能打开；现有定时任务列表能返回；在启用之前新路由仍然不存在（404）。

## 启用运营路由并调用

只在镜像是包含 S2 的 `-befreed` 构建、且上面的换镜像已健康之后才做。

1. 找到平台账号的用户 id（即拥有客户 agent 的那个账号）。用它的令牌：`curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER/api/v1/me"` -> `user.id`。
2. 在 `/opt/opentag/.env` 中加入（compose 通过 `env_file` 把整个 `.env` 传进去）：

   ```
   OPENTAG_OPERATOR_ROUTES_ENABLED=true
   OPENTAG_OPERATOR_USER_IDS=<平台账号用户id>[,<第二个id>]
   ```

   启用但名单为空或格式错误会让服务器在启动时报错，而不是猜测。最多 16 个 id。
3. `docker compose up -d`（用新环境变量重启容器）。
4. 再关闭：把 `OPENTAG_OPERATOR_ROUTES_ENABLED` 设为 `false`（或删掉两行）并 `docker compose up -d`。

调用示例（只有占位符；`$TOKEN` 是平台账号令牌，绝不写进仓库里的文件）：

```bash
# cron，带明确时区
curl -fsS -X POST "$SERVER/api/v1/operator/agents/$AGENT_ID/schedules" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"channelId":"<slack频道或私信id>","conversationKind":"dm","name":"daily-seo",
       "prompt":"<任务文本>","schedule":{"kind":"cron","expression":"0 9 * * *"},"timezone":"America/Los_Angeles"}'

# 一次性，绝对时刻
#   "schedule":{"kind":"at","at":"2026-11-09T17:00:00Z"},"timezone":"UTC"
# 约 10 秒后运行一次（调度器每 5 秒扫描一次；晚于到点 30 秒以上会被跳过）
#   {"channelId":"...","conversationKind":"dm","name":"run-now","prompt":"...","runInSeconds":10}
# 创建为暂停：加 "enabled": false

# 用现有路由读回
curl -fsS -H "Authorization: Bearer $TOKEN" "$SERVER/api/v1/agents/$AGENT_ID/schedules"
```

错误：`401` 无令牌或令牌无效；`403 AGENT_FORBIDDEN` 不在白名单；`404` agent 不存在、是别的账号的 agent、或路由已关闭；`400` 请求体或规则无效（`SCHEDULE_INVALID_RULE`、`SCHEDULE_INVALID_TIMEZONE`）；`409` 没有 IM 绑定 / agent 不活跃或未绑定机器 / 没有未来触发时间。

需要记住的风险：平台令牌没有范围限制。路由开启后，持有它的人可以给该账号下任意 agent 一段提示词并触发一次回合。令牌放在 Secrets Manager，白名单只给平台账号，不用时关掉路由。

## 运营调度路由的已知限制

来自对 S2 路由的独立安全评审（无 P1/P2 阻塞项；以下是已接受并记录的限制）：

1. **没有幂等/重复保护。** 两次相同的创建调用会创建两个调度。使用规则：阶段接力脚本在创建之前**必须先列出该 agent 的调度**（幂等由调用方负责），响应丢失时不得盲目重试创建。
2. **「创建后暂停」不是一个事务。** 以 `enabled: false` 创建，实际是先创建再暂停；如果暂停这一步失败，可能留下一个处于运行状态的调度。暂停式创建出错后，要列出调度并暂停或删除多出来的那个。
3. **绑定选择不确定：** 当一个 agent 同时有 Slack 和飞书绑定时，路由会选其中一个，没有稳定规则。使用此路由的 agent 只保留一个 IM 绑定。
4. **路由没有限流。** 唯一的刹车是令牌白名单，以及不用时由运营关闭路由。
5. **`channelId` 没有校验**（不核对 agent 的绑定或 IM 平台）。错误的 ID 要到投递时才失败，创建时不报错。

## 重新基于更新的上游

策略：停在 v0.1.5 加我们的补丁；只有需要某个修复时才通过一次升级演练换基线。

1. `git fetch upstream && git checkout -b befreed/release-<new> befreed/release-0.1.4`
2. `git merge <上游标签>`；预期冲突的文件：`packages/server/src/app.ts` 和 `index.ts`（接线只有几行）。`packages/server/src/services/schedules/service.ts` 我们**没有**修改，但 `operator-service.ts` 从它导入 `AgentScheduleScope`、`ScheduleClock`、`scheduleDatabaseClock` 并调用 `createForAgent` / `pauseForAgent`：如果上游改了这些签名（它在 v0.1.5 之后的 `522ef31d` 里重写了创建目标的逻辑），就改 `operator-service.ts`，不改上游。
3. 重跑：`pnpm --filter @opentag/server exec vitest run src/__tests__/operator-schedule-api.test.ts src/__tests__/operator-routes-config.test.ts` 以及集成测试 `src/__tests__/integration/operator-schedules.test.ts`（需要 Docker）。
4. 如果上游发布了真正的账号级创建路由，就删掉 S2，改用他们的。
