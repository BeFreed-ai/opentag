# OpenTag 的 BeFreed 分叉

> Canonical source: [BEFREED.md](./BEFREED.md)
> Last synced with: 2026-11-08

本仓库是 `BeFreed-ai/opentag`，即 `first-tree-ai/opentag`（Apache-2.0）的分叉。它**不是**上游正式发布版，也不得以上游产品的名义呈现（见 `NOTICE`）。我们的工作绝不在上游仓库开 PR、issue 或评论；所有改动先落在本仓库。

基线：上游标签 `v0.1.5`（`606a58b05541b0c4073b157374d05771f3d6fb4e`）。发布线是分支 `befreed/release-0.1.4`（名字是历史遗留，内容是 v0.1.5 加下面的补丁）。不要从 `main` 构建：它远落后于上游，不是部署基线。

## 我们相对上游 v0.1.5 的补丁

每个补丁都很小，默认关闭或仅做诊断，且不新增数据库迁移。

| # | 范围 | 文件 | 目的 | 默认 |
|---|------|------|------|------|
| C1 | 客户端 | `packages/client/src/runtime/session-message-inbox.ts`、`agent-turn-runner.ts`、新增 `provider-launch-configuration.ts`（含测试） | 定时（session-message）回合拿到服务器授予的 MCP 网关和网页工具 | 开 |
| C2 | 客户端 | `packages/client/src/runtime/context-tree-command-diagnostics.ts`、`context-tree-commands.ts`（含测试） | 记录 Context Tree 网关失败（仅诊断） | 开 |
| C3 | 客户端构建 | `scripts/befreed/set-fork-version.mjs`、`scripts/portable/build-portable.mjs` | 允许 `<稳定版>-befreed.<n>` 版本标签 | 不适用 |
| C4 | CI | `.github/workflows/befreed-client-release.yml`、`befreed-upstream-sync.yml` | 分叉客户端发布；每周在分叉内开"上游有新内容"的提醒 PR | 手动 / 每周 |
| S1 | 服务器构建 | `.github/workflows/befreed-server-image.yml` | 上游 `docker.yml` 只在上游仓库运行；本流水线用同一个 Dockerfile（`runtime` 目标）构建并推到我们自己命名空间下的 GHCR | 手动 |
| S2 | 服务器 | 新增 `packages/server/src/services/schedules/operator-service.ts`、`packages/server/src/api/operator-schedules.ts`、`packages/server/src/operator-routes-config.ts`；接线在 `packages/server/src/app.ts`（+8 行）和 `packages/server/src/index.ts`（+9 行） | 运营专用的账号级路由：为 agent 创建定时任务，无需入站 IM 消息（cron、一次性 `at`、或"N 秒后运行"） | **关** |
| S3 | 服务器测试 | `packages/server/src/__tests__/operator-schedule-api.test.ts`、`operator-routes-config.test.ts`、`__tests__/integration/operator-schedules.test.ts` | S2 的测试 | 不适用 |

S2 复用上游代码处理所有规则：`ScheduleService.createForAgent` 校验 cron 语法、时区、未来触发时间、提示词大小（16 KiB）并写入记录、版本号和审计事件；`SessionService.ensureChatSession` 查找或创建目标会话，并要求 agent 处于活跃状态且已绑定机器。S2 只是在调用方通过鉴权、运营白名单和归属检查之后，构造上游通常从 agent 的会话证明里推导出的"范围"。它从不读取或伪造会话证明。

### S2 做什么、不做什么

- 路由：`POST /api/v1/operator/agents/:agentId/schedules`。仅当 `OPENTAG_OPERATOR_ROUTES_ENABLED=true` 时注册；否则该路径不存在（404，和任何未知路径一样）。
- 检查顺序：平台账号的 Bearer 令牌（拒绝 cookie 会话）-> 用户 id 必须在 `OPENTAG_OPERATOR_USER_IDS` 中（否则在读取请求体之前返回 403 `AGENT_FORBIDDEN`）-> 严格的请求体校验（400）-> agent 必须属于调用账号且未删除（否则 404，与账号侧列表/查看路由的隐藏方式一致）-> agent 需要有活跃的 IM 绑定（409 `SCHEDULE_TARGET_REQUIRED`），且 agent 活跃并绑定了机器（409 `SCHEDULE_TARGET_INVALID`）。
- 它仍然需要 agent 已有 IM 绑定（Slack 或飞书）：会话总是挂在绑定上。它去掉的是"需要有人先发第一条消息"，不是"需要绑定"。
- 请求体：`channelId`、`conversationKind`（`channel|dm|group_dm`）、`name`、`prompt`，再加 `schedule`（`cron`、`at` 或 `every`）和 `timezone`，或者 `runInSeconds`（5..3600，按服务器数据库时钟计算，一次性，不能与 `enabled:false` 同用），以及可选的 `enabled`（默认 true；false 则创建后为暂停状态）。
- 只创建。列出、读取、暂停、恢复、删除都用现有账号路由（`GET/POST/DELETE /api/v1/agents/:agentId/schedules...`）。
- 审计：每次调用一行结构化日志（`operator.schedule.created|denied|failed`），含运营者用户 id、agent id、定时任务 id 和规则类型；绝不含提示词、令牌或任何请求头。上游自己的 `schedule.created` 事件也会记录。该日志不是持久审计链，持久审计请继续用 Host 侧的审计链。
- 已知限制：规则校验失败的请求（例如 cron 写错）可能留下一个空的频道会话（无害，下次同频道调用会复用）。`enabled:false` 是两步（先创建再暂停），所以马上到点的任务理论上可能运行一次；不要把它和马上触发的 `at` 一起用。
- 拒绝 cookie 会话是防御性的第二道检查；见 PR 中的"未验证"一节。

## 镜像构建与发布（S1）

镜像仓库：`ghcr.io/befreed-ai/opentag`。只用工作流默认的 `GITHUB_TOKEN`（`packages: write`、`contents: write`）：不需要新密钥、不涉及 AWS 和 IAM。

标签格式：`<上游版本>-befreed.<n>`，例如 `0.1.5-befreed.1`。基础版本必须等于源码的上游版本（`apps/cli/package.json`）；`n` 绝不重用（镜像标签或 git 标签 `befreed-server-v<version>` 已存在时运行会拒绝）。git 标签记录确切的源码 SHA。

```bash
gh workflow run "BeFreed server image" --repo BeFreed-ai/opentag \
  -f version=0.1.5-befreed.1 -f ref=<我们的发布分支或 SHA>
gh run watch --repo BeFreed-ai/opentag
```

一次性操作，由组织所有者完成（工作流做不到）：首次推送会把 GHCR 包创建为**私有**。要么把它改成公开（GitHub -> 组织 -> Packages -> `opentag` -> Package settings -> Change visibility），让主机像现在拉上游镜像一样匿名拉取；要么创建一个只读（`read:packages`）令牌并在主机上 `docker login ghcr.io`（该令牌是新密钥，不要放进仓库）。

平台：只构建 `linux/amd64`（OpenTag 主机是 x86_64）。关闭了 provenance 和 SBOM 证明，使标签是单平台的普通清单。需要逐字节确定时按摘要（digest）固定；工作流摘要里会打印它。

## 部署手册（EC2 + docker compose）与回滚

前提：不要在每日 SEO 整轮期间做（重启会切断正在运行的 agent 回合，且服务器是单实例）；先做新的 EBS 快照和新的 `pg_dump`（与 0.1.5 升级时相同）；上面的镜像已存在且主机能拉取。S2 **不新增迁移**，所以换镜像是对称的，回滚就是改回一行。（以后任何带迁移的补丁都会打破这种对称：上游迁移不会随镜像回滚。）

在主机上（以拥有 `/opt/opentag` 的用户），尖括号为占位符：

```bash
cd /opt/opentag
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"                 # 留好；里面有旧的镜像行
grep '^OPENTAG_IMAGE=' .env                               # 记下当前值 = 回滚目标
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=ghcr.io/befreed-ai/opentag:<version>|' .env
docker compose pull opentag && docker compose up -d       # 服务名以 docker-compose.yml 中的为准
docker compose ps                                         # opentag 健康（镜像带 /healthz 健康检查）
curl -fsS http://127.0.0.1:8000/healthz
```

回滚（任何时候都可以；即使已经通过新路由创建了定时任务也可以，因为表结构没变，已创建的任务会留着并继续触发）：

```bash
cd /opt/opentag
sed -i 's|^OPENTAG_IMAGE=.*|OPENTAG_IMAGE=<你记下的旧值，例如 ghcr.io/first-tree-ai/opentag:606a58b0...>|' .env
docker compose pull opentag && docker compose up -d
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

## 重新基于更新的上游

策略：停在 v0.1.5 加我们的补丁；只有需要某个修复时才通过一次升级演练换基线。

1. `git fetch upstream && git checkout -b befreed/release-<new> befreed/release-0.1.4`
2. `git merge <上游标签>`；预期冲突的文件：`packages/server/src/app.ts` 和 `index.ts`（接线只有几行）。`packages/server/src/services/schedules/service.ts` 我们**没有**修改，但 `operator-service.ts` 从它导入 `AgentScheduleScope`、`ScheduleClock`、`scheduleDatabaseClock` 并调用 `createForAgent` / `pauseForAgent`：如果上游改了这些签名（它在 v0.1.5 之后的 `522ef31d` 里重写了创建目标的逻辑），就改 `operator-service.ts`，不改上游。
3. 重跑：`pnpm --filter @opentag/server exec vitest run src/__tests__/operator-schedule-api.test.ts src/__tests__/operator-routes-config.test.ts` 以及集成测试 `src/__tests__/integration/operator-schedules.test.ts`（需要 Docker）。
4. 如果上游发布了真正的账号级创建路由，就删掉 S2，改用他们的。
