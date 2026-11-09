/**
 * WeChat (personal WeChat / ClawBot) channel for DeepSeek Harness.
 *
 * Long-polls Tencent's iLink Bot API, turns every inbound direct message into one
 * ordinary DSH Agent turn, and sends the assistant's text back. Each WeChat chat is
 * bound to one persistent DSH Session, so context survives restarts and unrelated
 * chats never share history.
 *
 * The plugin reuses the iLink credentials the Hermes weixin adapter saved under
 * `~/.hermes/weixin/accounts/`, which keeps one WeChat contact: ClawBot allows a
 * single paired bot per WeChat user, so a second pairing would displace the first.
 * Only one process may poll an account at a time, so the Hermes gateway's Weixin
 * platform must be stopped before this plugin runs.
 *
 * @module dsh-weixin
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { discoverAccount } from './account.ts'
import {
  IlinkApiError,
  IlinkClient,
  TYPING_START,
  TYPING_STOP,
  extractText,
  splitMessage,
  type IlinkMessage,
} from './ilink.ts'
import { ChatStore, Deduper, weixinDomain } from './store.ts'

/** Services the bridge reads; all are part of the standard dsh-base + dsh-web-app composition. */
export const inject = [
  'agents',
  'sessions',
  'storageDomain',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
]

/** Runtime configuration for the WeChat channel. */
export interface Config {
  /** iLink bot account id; defaults to `WEIXIN_ACCOUNT_ID` and then the newest saved login. */
  accountId?: string
  /** Overrides the saved token; normally discovered from the Hermes store. */
  token?: string
  /** Overrides the iLink API base URL. */
  baseUrl?: string
  /** Working directory for sessions this channel creates. */
  workspace?: string
  /** WeChat user ids allowed to talk to the bot; empty allows the paired owner only. */
  allowedUsers: string[]
  /** Agent route as `provider/model`; omission follows the deployment default model. */
  model?: string
  /** Agent preset mounted into sessions this channel creates. */
  agentPreset: string
  /** Permission preset applied to sessions this channel creates. */
  permissionPreset: string
  /** Answer approval prompts for owned sessions instead of leaving them pending. */
  autoApprove: boolean
  /** Largest outbound chunk; WeChat renders very long bubbles poorly. */
  maxMessageLength: number
  /** Abort one turn that runs longer than this and tell the user. */
  turnTimeoutMs: number
  /** Delay between consecutive outbound chunks. */
  chunkDelayMs: number
}

export const Config: Schema<Config> = Schema.object({
  accountId: Schema.string(),
  token: Schema.string(),
  baseUrl: Schema.string(),
  workspace: Schema.string(),
  allowedUsers: Schema.array(Schema.string()).default([]),
  model: Schema.string(),
  agentPreset: Schema.string().default('standard'),
  permissionPreset: Schema.string().default('danger-full-access'),
  autoApprove: Schema.boolean().default(false),
  maxMessageLength: Schema.natural().min(200).default(2000),
  turnTimeoutMs: Schema.natural().min(10_000).default(20 * 60_000),
  chunkDelayMs: Schema.natural().default(300),
})

/** One prompt waiting on its agent turn, plus the output collected for it. */
interface InflightTurn {
  messageId: string | undefined
  turn: number | undefined
  readonly parts: string[]
  endReason: TurnEndReason | undefined
  failure: Error | undefined
  readonly settled: Promise<void>
  settle: () => void
}

const COMMAND_PREFIX = '/'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Render assistant text blocks; reasoning and media never reach WeChat. */
function assistantText(event: SessionEvent<'assistant/message'>): string {
  const parts: string[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'text' && block.text.trim()) parts.push(block.text)
  }
  return parts.join('\n\n')
}

/** Explain a terminal turn reason without leaking a stack trace. */
function describeEnd(reason: TurnEndReason): string | undefined {
  if (reason.kind === 'error') return `运行失败：${reason.error.message}`
  if (reason.kind === 'max-tokens') return '（本轮因输出长度上限被截断）'
  if (reason.kind === 'aborted') return '（本轮被中止）'
  return undefined
}

/** Await a promise with a deadline; resolves true when the deadline won. */
async function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms)
  })
  try {
    return await Promise.race([promise.then(() => false), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Mount the WeChat channel.
 * @param ctx - Cordis context carrying the Agent factory and Session services.
 * @param config - channel configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const bridge = new WeixinBridge(ctx, config)
  ctx.effect(() => {
    const starting = bridge.start()
    return async () => {
      await starting.catch(() => {})
      await bridge.stop()
    }
  }, 'weixin.lifecycle')

  ctx.on('session/event', (session, event) => bridge.onSessionEvent(session, event))
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => bridge.onInboxClaimed(agent, message.id, turn))
  ctx.on('agent/error', ({ agent, error }) => bridge.onAgentError(agent, error))
  ctx.on('approval/request', (request, next) => bridge.onApprovalRequest(request, next))
}

/** The channel runtime: iLink polling, per-chat queues, and reply delivery. */
class WeixinBridge {
  private readonly deduper = new Deduper()
  private readonly typingTickets = new Map<string, { ticket: string; at: number }>()
  private readonly agents = new Map<string, Agent>()
  private readonly handles = new Map<string, AgentHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly inflight = new Map<string, InflightTurn>()
  private readonly workspace: string
  private domain: Domain<typeof weixinDomain> | undefined
  private store: ChatStore | undefined
  private client: IlinkClient | undefined
  private accountUserId = ''
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {
    const configured = config.workspace
    this.workspace = configured !== undefined && isAbsolute(configured) ? configured : join(homedir(), 'Documents')
  }

  /** Open durable state, resolve credentials, and begin long-polling. */
  async start(): Promise<void> {
    try {
      await this.startInner()
    } catch (error) {
      this.ctx.logger.error(`weixin: bridge failed to start: ${(error as Error).message}`)
      throw error
    }
  }

  private async startInner(): Promise<void> {
    if (this.stopped) return
    const domain = await this.ctx.storageDomain.open(weixinDomain)
    if (this.stopped) {
      await domain.close()
      return
    }
    this.domain = domain
    this.store = new ChatStore(domain)

    const account = await this.resolveAccount()
    if (this.stopped) return
    if (account === undefined) {
      this.ctx.logger.warn(
        'weixin: no iLink credentials found; pair ClawBot once with `hermes gateway setup`, then restart this plugin',
      )
      return
    }
    this.client = new IlinkClient({ token: account.token, baseUrl: this.config.baseUrl || account.base_url })
    this.accountUserId = account.user_id ?? ''
    this.ctx.logger.warn(
      `weixin: polling iLink account ${account.account_id}${this.accountUserId ? ` as ${this.accountUserId}` : ''}`,
    )
    void this.poll().catch((error: unknown) => {
      this.ctx.logger.error(`weixin: poll loop stopped: ${(error as Error).message}`)
    })
  }

  /** Stop polling, flush the live Sessions, and close durable state. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const [chatId, agent] of this.agents) {
      try {
        await agent.whenIdle()
        await this.ctx.sessions.flush(agent.session)
        await this.handles.get(chatId)?.dispose()
      } catch {
        // A closing Host may already have removed the Session; the domain still closes.
      }
    }
    this.agents.clear()
    this.handles.clear()
    await this.domain?.close().catch((error: unknown) => {
      this.ctx.logger.warn(`weixin: closing the state domain failed: ${(error as Error).message}`)
    })
  }

  /** Resolve configured credentials, then the saved Hermes login. */
  private async resolveAccount(): Promise<{ account_id: string; token: string; base_url?: string; user_id?: string } | undefined> {
    if (this.config.token) {
      return {
        account_id: this.config.accountId ?? 'configured',
        token: this.config.token,
        base_url: this.config.baseUrl,
      }
    }
    return discoverAccount(this.config.accountId)
  }

  /** One long-poll loop with bounded exponential backoff. */
  private async poll(): Promise<void> {
    const client = this.client
    const store = this.store
    if (client === undefined || store === undefined) return
    let failures = 0
    while (!this.stopped) {
      try {
        const startedAt = Date.now()
        const response = await client.getUpdates(store.syncBuf())
        failures = 0
        const ret = response.ret
        const errcode = response.errcode
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          this.ctx.logger.warn(
            `weixin: getupdates ret=${String(ret)} errcode=${String(errcode)} ${String(response.errmsg ?? '')}`,
          )
          if (ret === -14 || errcode === -14) {
            this.ctx.logger.error('weixin: ClawBot session expired; re-pair with `hermes gateway setup`')
            await sleep(60_000)
          }
          continue
        }
        for (const message of response.msgs ?? []) await this.handleMessage(message)
        const nextBuf = response.get_updates_buf
        if (nextBuf !== undefined && nextBuf !== '') await store.setSyncBuf(nextBuf)
        // A near-instant empty response is not a long poll; pace it instead of hot-looping.
        else {
          const elapsed = Date.now() - startedAt
          if (elapsed < 1_000) await sleep(1_000 - elapsed)
        }
      } catch (error) {
        if (this.stopped) return
        failures += 1
        const delay = Math.min(30_000, 2_000 * 2 ** Math.min(failures, 4))
        this.ctx.logger.warn(`weixin: poll error (${failures}): ${(error as Error).message}; retrying in ${delay}ms`)
        await sleep(delay)
      }
    }
  }

  /** Validate, deduplicate, and dispatch one inbound message. */
  private async handleMessage(message: IlinkMessage): Promise<void> {
    const from = String(message.from_user_id ?? '').trim()
    if (!from) return
    const messageId = String(message.message_id ?? '')
    if (messageId && this.deduper.duplicate(`id:${messageId}`)) return

    const text = extractText(message.item_list)
    if (text && this.deduper.duplicate(`text:${from}:${text}`)) return
    if (!this.isAllowed(from)) {
      this.ctx.logger.info(`weixin: ignoring message from unauthorized user ${from}`)
      return
    }

    const contextToken = String(message.context_token ?? '').trim()
    if (contextToken) await this.store?.setContextToken(from, contextToken)
    await this.store?.touch(from, new Date().toISOString())

    if (!text.trim()) {
      await this.reply(from, '目前只支持文字消息。')
      return
    }
    if (text.startsWith(COMMAND_PREFIX) && await this.handleCommand(from, text.trim())) return
    void this.enqueuePrompt(from, text)
  }

  /** Answer a slash command inline; returns true when the text was a command. */
  private async handleCommand(chatId: string, text: string): Promise<boolean> {
    const [command] = text.split(/\s+/, 1)
    switch (command) {
      case '/new':
      case '/reset': {
        const agent = this.agents.get(chatId)
        const handle = this.handles.get(chatId)
        this.agents.delete(chatId)
        this.handles.delete(chatId)
        const hadSession = await this.storeHasChat(chatId)
        await this.store?.deleteChat(chatId)
        if (agent !== undefined) {
          try {
            agent.cancel({ kind: 'user' })
            await agent.whenIdle()
            await this.ctx.sessions.flush(agent.session)
            await handle?.dispose()
          } catch {
            // A stuck cancel must not block starting a fresh session.
          }
        }
        await this.reply(chatId, hadSession ? '已开启新会话。' : '当前没有活动会话，下一条消息会新建一个。')
        return true
      }
      case '/stop': {
        const agent = this.agents.get(chatId)
        agent?.cancel({ kind: 'user' })
        await this.reply(chatId, agent === undefined ? '没有正在运行的任务。' : '已请求中止当前任务。')
        return true
      }
      case '/status': {
        const agent = this.agents.get(chatId)
        const chat = this.store?.chat(chatId)
        if (agent === undefined && chat === undefined) {
          await this.reply(chatId, '还没有会话。发一条消息即可开始。')
          return true
        }
        const sessionId = agent?.session.header.id ?? chat?.sessionId
        const route = agent === undefined ? '（空闲）' : describeRoute(agent)
        const status = agent?.status ?? 'sleeping'
        await this.reply(chatId, `会话：${sessionId}\n模型：${route}\n状态：${status}`)
        return true
      }
      case '/help': {
        await this.reply(chatId, ['/new 开始新会话', '/stop 中止当前任务', '/status 查看当前会话', '/help 显示帮助'].join('\n'))
        return true
      }
      default:
        return false
    }
  }

  private async storeHasChat(chatId: string): Promise<boolean> {
    return this.store?.chat(chatId) !== undefined
  }

  /** Serialize prompts per chat so two messages never interleave one turn. */
  private enqueuePrompt(chatId: string, text: string): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.runPrompt(chatId, text))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`weixin: prompt for ${chatId} failed: ${(error as Error).message}`)
      })
    this.queues.set(chatId, next)
    return next
  }

  /** Resolve the chat's Agent, submit one prompt, and deliver its output. */
  private async runPrompt(chatId: string, text: string): Promise<void> {
    const agent = await this.resolveAgent(chatId)
    void this.typing(chatId, true)
    const inflight = this.beginInflight(chatId)
    try {
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
      inflight.messageId = message.id
      try {
        agent.followup(message)
      } catch (error) {
        await this.reply(chatId, `任务没有开始：${(error as Error).message}`)
        return
      }

      if (await raceTimeout(inflight.settled, this.config.turnTimeoutMs)) {
        agent.cancel({ kind: 'user' })
        await this.reply(chatId, '任务运行超时，已中止。可以发「继续」让我接着做。')
        return
      }
      if (inflight.failure !== undefined) {
        await this.reply(chatId, `运行失败：${inflight.failure.message}`)
        return
      }
      await agent.whenIdle()
      const note = inflight.endReason === undefined ? undefined : describeEnd(inflight.endReason)
      const body = inflight.parts.join('\n\n').trim()
      if (!body && note === undefined) {
        await this.reply(chatId, '（本轮没有文本输出）')
        return
      }
      await this.reply(chatId, [body, note].filter(Boolean).join('\n\n'))
    } finally {
      this.inflight.delete(chatId)
      void this.typing(chatId, false)
    }
  }

  /** Reuse a live Agent, resume the persisted Session, or create a fresh one. */
  private async resolveAgent(chatId: string): Promise<Agent> {
    const live = this.agents.get(chatId)
    if (live !== undefined && this.ctx.agents.get(live.session.header.id) === live) return live

    const chat = this.store?.chat(chatId)
    if (chat?.sessionId !== undefined) {
      const attached = this.ctx.agents.get(brandString<SessionId>(chat.sessionId))
      if (attached !== undefined) return this.trackAgent(chatId, attached)
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: brandString<SessionId>(chat.sessionId),
          agentOptions: this.agentOptions(),
          setup: agentCtx => this.mountPreset(agentCtx, chat.agentPreset),
        })
        return this.track(chatId, handle)
      } catch (error) {
        this.ctx.logger.warn(
          `weixin: resuming ${chat.sessionId} failed (${(error as Error).message}); starting a new session`,
        )
        await this.store?.deleteChat(chatId)
      }
    }

    const sessionId = brandString<SessionId>(`weixin-${randomUUID()}`)
    const preset = await this.resolvePreset()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.workspace, ...(preset === undefined ? {} : { agentPreset: preset.id }) },
      agentOptions: this.agentOptions(),
      setup: agentCtx => this.mountPreset(agentCtx, preset?.id),
    })
    const agent = this.track(chatId, handle)
    this.applyPermissionPreset(handle.agent.session)
    this.renameSession(handle.agent.session, chatId)
    const existing = this.store?.chat(chatId)
    await this.store?.putChat(chatId, {
      sessionId,
      title: `微信 · ${chatId.slice(0, 8)}`,
      lastInboundAt: existing?.lastInboundAt ?? new Date().toISOString(),
      ...(existing?.contextToken === undefined ? {} : { contextToken: existing.contextToken }),
      ...(preset === undefined ? {} : { agentPreset: preset.id }),
    })
    void this.ctx.sessions.flush(handle.agent.session)
    return agent
  }

  /** Resolve the configured agent preset, or undefined when the registry rejects it. */
  private async resolvePreset(): Promise<AgentPreset | undefined> {
    try {
      return await this.ctx.agentPresets.resolve(this.config.agentPreset)
    } catch (error) {
      this.ctx.logger.warn(`weixin: unknown agent preset "${this.config.agentPreset}": ${(error as Error).message}`)
      return undefined
    }
  }

  /** Mount one preset into an unpublished Agent scope; a preset-less Agent keeps the global rows. */
  private async mountPreset(agentCtx: Context, presetId: string | undefined): Promise<void> {
    if (presetId === undefined) return
    try {
      await this.ctx.agentPresets.mount(agentCtx, presetId)
    } catch (error) {
      this.ctx.logger.warn(`weixin: mounting agent preset "${presetId}" failed: ${(error as Error).message}`)
    }
  }

  /** Register the chat's owned Agent handle. */
  private track(chatId: string, handle: AgentHandle): Agent {
    this.handles.set(chatId, handle)
    return this.trackAgent(chatId, handle.agent)
  }

  /** Register an Agent the Host already owns (a live session adopted by id). */
  private trackAgent(chatId: string, agent: Agent): Agent {
    this.agents.set(chatId, agent)
    return agent
  }

  /** Apply the configured permission preset, tolerating an unknown name. */
  private applyPermissionPreset(session: Session): void {
    try {
      this.ctx.permissionPresets.resolve(this.config.permissionPreset)
      this.ctx.permissionPresets.set(session, this.config.permissionPreset)
    } catch (error) {
      this.ctx.logger.warn(`weixin: permission preset "${this.config.permissionPreset}" was rejected: ${(error as Error).message}`)
    }
  }

  /** Title the session for the DSH sidebar; failure is cosmetic. */
  private renameSession(session: Session, chatId: string): void {
    const title = this.ctx.get('sessionTitle') as SessionTitleService | undefined
    try {
      title?.rename(session, `微信 · ${chatId.slice(0, 8)}`)
    } catch {
      // The title service is optional outside the web composition.
    }
  }

  /** Build the Agent route, following the deployment default when unconfigured. */
  private agentOptions(): { provider?: string; model?: string } {
    const configured = this.config.model
    if (configured !== undefined && configured.includes('/')) {
      const [provider, ...rest] = configured.split('/')
      return { provider, model: rest.join('/') }
    }
    const selection = this.ctx.agentDefaultModel.currentSelection()
    if (selection === undefined) return {}
    return { provider: selection.provider, model: selection.model }
  }

  /** Open one prompt slot and expose the promise resolved at turn end. */
  private beginInflight(chatId: string): InflightTurn {
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const inflight: InflightTurn = {
      messageId: undefined,
      turn: undefined,
      parts: [],
      endReason: undefined,
      failure: undefined,
      settled,
      settle,
    }
    this.inflight.set(chatId, inflight)
    return inflight
  }

  /** Correlate an accepted inbox message with the turn that claims it. */
  onInboxClaimed(agent: Agent, messageId: string, turn: number): void {
    const chatId = this.chatOf(agent)
    if (chatId === undefined) return
    const inflight = this.inflight.get(chatId)
    if (inflight?.messageId === messageId) inflight.turn = turn
  }

  /** Record the assistant's text and close the slot at turn end. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    const chatId = this.chatOfSession(session)
    if (chatId === undefined) return
    const inflight = this.inflight.get(chatId)
    if (inflight === undefined) return
    if (event.type === 'assistant/message') {
      if (inflight.turn === undefined || event.data.turn === inflight.turn) {
        const text = assistantText(event)
        if (text) inflight.parts.push(text)
      }
      return
    }
    if (event.type === 'turn/end' && event.data.turn === inflight.turn) {
      inflight.endReason = event.data.reason
      inflight.settle()
    }
  }

  /** Surface a driver-level failure that produced no turn. */
  onAgentError(agent: Agent, error: unknown): void {
    const chatId = this.chatOf(agent)
    if (chatId === undefined) return
    const inflight = this.inflight.get(chatId)
    if (inflight === undefined) return
    inflight.failure = new Error((error as Error).message ?? String(error))
    inflight.settle()
  }

  /** Answer approval prompts when configured, so an unattended chat cannot stall. */
  async onApprovalRequest(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.config.autoApprove || this.chatOf(request.agent) === undefined) return next()
    return 'allowed-once'
  }

  /** Chat id bound to one live Agent. */
  private chatOf(agent: Agent): string | undefined {
    for (const [chatId, candidate] of this.agents) {
      if (candidate === agent) return chatId
    }
    return undefined
  }

  /** Chat id bound to one Session. */
  private chatOfSession(session: Session): string | undefined {
    for (const [chatId, agent] of this.agents) {
      if (agent.session === session || agent.session.header.id === session.header.id) return chatId
    }
    return undefined
  }

  /** Show or clear the "typing…" indicator; never fatal. */
  private async typing(chatId: string, start: boolean): Promise<void> {
    const client = this.client
    if (client === undefined) return
    try {
      const ticket = await this.typingTicket(chatId)
      if (!ticket) return
      await client.sendTyping(chatId, ticket, start ? TYPING_START : TYPING_STOP)
    } catch {
      // Typing is decoration; delivery failures belong to the reply path.
    }
  }

  /** Cache the typing ticket for most of its 10-minute server TTL. */
  private async typingTicket(chatId: string): Promise<string> {
    const cached = this.typingTickets.get(chatId)
    if (cached !== undefined && Date.now() - cached.at < 540_000) return cached.ticket
    const client = this.client
    if (client === undefined) return ''
    const ticket = await client.getTypingTicket(chatId, this.store?.contextToken(chatId))
    if (ticket) this.typingTickets.set(chatId, { ticket, at: Date.now() })
    return ticket
  }

  /** Deliver text in chunks, retrying transient iLink failures. */
  private async reply(chatId: string, text: string): Promise<void> {
    const chunks = splitMessage(text, this.config.maxMessageLength)
    for (const [index, chunk] of chunks.entries()) {
      try {
        await this.sendChunk(chatId, chunk)
      } catch (error) {
        this.ctx.logger.error(`weixin: reply to ${chatId} failed: ${(error as Error).message}`)
        return
      }
      if (index < chunks.length - 1 && this.config.chunkDelayMs > 0) await sleep(this.config.chunkDelayMs)
    }
  }

  /** Send one chunk; a stale reply token falls back to a tokenless send once. */
  private async sendChunk(chatId: string, chunk: string): Promise<void> {
    const client = this.client
    if (client === undefined) throw new Error('the iLink client is not initialized')
    let contextToken: string | undefined = this.store?.contextToken(chatId)
    let retriedWithoutToken = false
    let attempts = 0
    for (;;) {
      try {
        await client.sendText(chatId, chunk, contextToken)
        return
      } catch (error) {
        if (error instanceof IlinkApiError) {
          if (error.sessionExpired && !retriedWithoutToken && contextToken !== undefined) {
            retriedWithoutToken = true
            contextToken = undefined
            continue
          }
          if (error.rateLimited && attempts < 3) {
            attempts += 1
            await sleep(1_500 * 3 ** attempts)
            continue
          }
        }
        if (attempts >= 3) throw error
        attempts += 1
        await sleep(1_000 * attempts)
      }
    }
  }

  /** Allowlist check: configured ids win; otherwise only the paired owner. */
  private isAllowed(userId: string): boolean {
    if (this.config.allowedUsers.length > 0) return this.config.allowedUsers.includes(userId)
    if (!this.accountUserId) return true
    return userId === this.accountUserId
  }
}

/** Stable route label for `/status`. */
function describeRoute(agent: Agent): string {
  const selection = agent.model.current()
  return selection === undefined ? '（未记录）' : `${selection.provider}/${selection.model}`
}
