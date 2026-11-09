/**
 * Durable bridge state: which DSH Session serves which WeChat chat, the iLink
 * `context_token` needed to reply, and the long-poll cursor.
 *
 * The records live in a `storage-domain` domain so they are schema-validated,
 * atomically persisted by the profile's storage backend, and visible to the rest of
 * the Host instead of sitting in a private JSON file.
 */

import { z } from 'zod'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'

/** One chat's binding to a persistent Session. */
const chatSchema = z.object({
  /** DSH Session identity serving this chat; absent until the first prompt. */
  sessionId: z.string().min(1).optional(),
  /** Sidebar title. */
  title: z.string(),
  /** ISO instant of the last inbound message; iLink drops pushes after 24h of silence. */
  lastInboundAt: z.string().min(1),
  /** Latest iLink reply token; replies must echo it. */
  contextToken: z.string().min(1).optional(),
  /** Agent preset mounted into this Session; omitted for preset-less agents. */
  agentPreset: z.string().min(1).optional(),
})

export type ChatState = z.infer<typeof chatSchema>

const cursorSchema = z.object({ syncBuf: z.string() })

/** The bridge's storage declaration. */
export const weixinDomain = defineDomain({
  name: 'weixin',
  version: 1,
  global: { schema: cursorSchema, initial: { syncBuf: '' } },
  tables: { chats: domainTable<string, ChatState>(chatSchema) },
})

/** Typed accessors over the open domain. */
export class ChatStore {
  constructor(private readonly domain: Domain<typeof weixinDomain>) {}

  /** One chat binding, if the chat has talked to this bot before. */
  chat(chatId: string): ChatState | undefined {
    return this.domain.table('chats').get(chatId)
  }

  /** Current long-poll cursor. */
  syncBuf(): string {
    return this.domain.global.get().syncBuf
  }

  /** Advance the long-poll cursor after a delivered batch. */
  async setSyncBuf(syncBuf: string): Promise<void> {
    if (this.syncBuf() === syncBuf) return
    await this.domain.global.set({ syncBuf })
  }

  /** Latest reply token for a chat. */
  contextToken(chatId: string): string | undefined {
    return this.chat(chatId)?.contextToken
  }

  /** Create or replace one chat binding. */
  async putChat(chatId: string, state: ChatState): Promise<void> {
    await this.domain.table('chats').put(chatId, state)
  }

  /** Refresh only the reply token, keeping the session binding. */
  async setContextToken(chatId: string, contextToken: string): Promise<void> {
    const existing = this.chat(chatId)
    if (existing?.contextToken === contextToken) return
    await this.domain.table('chats').put(chatId, {
      title: existing?.title ?? `微信 · ${chatId.slice(0, 8)}`,
      lastInboundAt: existing?.lastInboundAt ?? new Date().toISOString(),
      ...existing?.sessionId === undefined ? {} : { sessionId: existing.sessionId },
      ...existing?.agentPreset === undefined ? {} : { agentPreset: existing.agentPreset },
      contextToken,
    })
  }

  /** Record the last inbound instant so the 24h window is observable. */
  async touch(chatId: string, at: string): Promise<void> {
    const existing = this.chat(chatId)
    if (existing === undefined) return
    await this.domain.table('chats').put(chatId, { ...existing, lastInboundAt: at })
  }

  /** Forget a chat binding when the user starts a new session. */
  async deleteChat(chatId: string): Promise<void> {
    await this.domain.table('chats').delete(chatId)
  }

  /** Every bound chat, for diagnostics. */
  entries(): IterableIterator<[string, ChatState]> {
    return this.domain.table('chats').entries()
  }
}

/** 5-minute sliding dedupe window; iLink retries deliveries under fresh ids. */
export class Deduper {
  private readonly seen = new Map<string, number>()

  constructor(private readonly ttlMs = 300_000) {}

  /** Returns true when the key was already seen inside the window. */
  duplicate(key: string): boolean {
    const now = Date.now()
    for (const [existing, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(existing)
    }
    if (this.seen.has(key)) return true
    this.seen.set(key, now)
    return false
  }
}
