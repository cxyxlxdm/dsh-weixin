# dsh-weixin

DeepSeek Harness 的微信通道插件。把个人微信（ClawBot / iLink）接到 DSH 上：你在微信里发消息，DSH 的 Agent 在会话里执行，结果回到微信。

不是企业微信，也不是公众号。用的是腾讯 iLink Bot API，也就是微信「设置 → 插件 → 微信 ClawBot」那套官方通道。

## 已实现

- **长轮询收消息**：`ilink/bot/getupdates`，35 秒长轮询 + 指数退避重连
- **会话保持**：一个微信聊天绑定一个 DSH Session，重启后自动 `agents.resume`，上下文不丢。会话会以「微信 · xxxxxxxx」出现在 Web 侧栏
- **回复投递**：`sendmessage` 每次回显 `context_token`；token 过期（`-14`）自动降级为无 token 重发一次；频率限制（`-2`）按 3 倍退避重试
- **正在输入**：`getconfig` 取 `typing_ticket`，任务期间点亮「正在输入…」
- **消息分块**：按 2000 字分段，优先在段落边界切开
- **去重**：message_id + 正文指纹 5 分钟窗口，iLink 重投不会重复执行
- **访问控制**：默认只认扫码配对的本人；`allowedUsers` 可改成白名单
- **命令**：`/new` `/stop` `/status` `/help`
- **媒体**：仅文字。图片、语音、文件当前回复「目前只支持文字消息」

## 前置：先有 iLink 登录

本插件不自己扫码，复用 Hermes weixin 适配器保存的凭据（`~/.hermes/weixin/accounts/<account_id>.json`）。原因：ClawBot 一个微信用户只允许一个 bot 身份，第二次配对会顶掉第一次。

没有凭据就先跑一次 `hermes gateway setup`，选 `WeChat (ilink / ClawBot)` 扫码。

## 安装

插件是标准 DSH bundle，用 `dsh plugin add` 装：

```bash
npm run build
dsh plugin --profile web add /绝对路径/dsh-weixin
```

`dsh` 不是全局命令时用安装目录的入口：

```bash
node /Users/cxyxl/Documents/workspace/deepseek-harness/apps/cli/lib/bin.js \
  plugin --profile web add /Users/cxyxl/Documents/personal-agent/dsh-weixin
```

装完它会出现在 **Plugins → 已安装** 里（bundle 列表），可开关。卸载：

```bash
dsh plugin --profile web remove @cxyxl/dsh-weixin
```

启用前必须确认：**没有第二个进程在轮询同一个 iLink 账号**。Hermes 网关的 weixin 平台和本插件只能有一个在跑，否则消息会被两边随机抢走。

`dsh plugin add` 改的是 profile 的 `package.json`（依赖 + `dsh.profile.bundles`），patch 层由包的 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: weixin
      name: "@cxyxl/dsh-weixin"
```

配置写在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖，或用 Plugins 页面的配置表单：

```yaml
- id: weixin
  config:
    workspace: /Users/cxyxl/Documents
    permissionPreset: danger-full-access
    autoApprove: true
```

## 配置

写在 patch 的 entry `config:` 下：

```yaml
- insert:
    - id: weixin
      name: ./plugins/dsh-weixin/lib/index.js
      config:
        workspace: /Users/cxyxl/Documents
        permissionPreset: danger-full-access
        autoApprove: true
```

| 键 | 默认 | 说明 |
|---|---|---|
| `accountId` | `WEIXIN_ACCOUNT_ID`，否则最新的账号 | 指定轮询哪个 bot |
| `token` / `baseUrl` | 读保存的账号 | 手动指定凭据 |
| `workspace` | `~/Documents` | 新建会话的工作目录 |
| `allowedUsers` | 空 = 仅扫码本人 | 允许私聊的微信 user id 列表 |
| `model` | 部署默认模型 | `provider/model` |
| `agentPreset` | `standard` | 挂载的 Agent 预设；web profile 不挂载会得到无工具 Agent |
| `permissionPreset` | `danger-full-access` | 无人值守场景下必须给足权限，否则工具调用会卡在审批 |
| `autoApprove` | `false` | 为 true 时直接放行本通道会话的审批请求 |
| `maxMessageLength` | `2000` | 单条气泡上限 |
| `turnTimeoutMs` | 20 分钟 | 超时中止并告知用户 |
| `chunkDelayMs` | 300 | 分段间隔 |

## 限制（来自 iLink 侧，不是本插件）

- **只有单聊**。iLink 不给 bot 身份推普通群事件，群聊请用企业微信 WeCom
- **24 小时窗口**。你超过 24 小时没给 ClawBot 发消息，它主动推送会被微信丢弃；你发任意一条消息即恢复
- **一个账号只能一个轮询方**。两个进程同时 poll 会分走消息
- token 长期不用会失效（`errcode=-14`），重跑 `hermes gateway setup` 扫码即可

## 结构

```
src/index.ts    Cordis 插件：entry 注册、iLink 轮询、每聊队列、回复投递
src/ilink.ts    iLink Bot API 客户端（getupdates/sendmessage/sendtyping/getconfig）
src/store.ts    storage-domain 域：chat → session 映射、context_token、轮询游标
src/account.ts  复用 ~/.hermes/weixin/accounts 下的账号
```

状态存在 `storage-domain` 的 `weixin` 域里，由 profile 的 storage 后端落盘，不是私有 JSON 文件。


## 发布与插件市场

包名 `@cxyxl/dsh-weixin`。`dsh-weixin` 这个名字在 npm 上已被 [caoyilearnai/dsh-weixin](https://github.com/caoyilearnai/dsh-weixin) 占用（0.2.1），所以用 scope 区分，不抢名。

发 npm：

```bash
npm publish --access public --registry https://registry.npmjs.org
```

插件市场走 DSH 的「自定义索引」机制，没有官方中心索引。索引文件是本仓库根目录的 [plugin-index.json](plugin-index.json)，通过 raw.githubusercontent 提供：

```
https://raw.githubusercontent.com/cxyxlxdm/dsh-weixin/main/plugin-index.json
```

在 **Plugins → Custom plugin indexes** 里加这个 URL，Discover 页就会出现「微信 ClawBot 通道」；索引里的版本指向 git 源并钉死 commit，所以不依赖 npm 发布也能装。每次发版更新索引里的 `commit` 和时间戳。

## 排障

| 现象 | 检查 |
|---|---|
| 日志 `no iLink credentials found` | 没扫过码，或 `HERMES_HOME` 指错 |
| 日志 `ClawBot session expired` | token 失效，重扫码 |
| 微信有「正在输入」但没回复 | Agent 那轮失败；看 `/status` 和 DSH 日志里的 `weixin:` 前缀 |
| 两条消息只回一条 | 另一条被去重命中（同一正文 5 分钟内），或另一个 poller 抢走了 |
| 群里 @ 没反应 | iLink 限制，不是配置问题 |
