/**
 * Minimal iLink Bot API client for personal WeChat (the WeChat "ClawBot" plugin).
 *
 * Wire contract mirrors the Hermes weixin adapter: long-poll `getupdates`, echo the
 * peer's `context_token` on every reply, and keep the iLink bookkeeping headers.
 * Only text, typing indicators, and the QR login are implemented here; media lives
 * outside this client.
 */

import { randomBytes, randomUUID } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const ILINK_APP_ID = 'bot'
const CHANNEL_VERSION = '2.2.0'
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8))

const EP_GET_UPDATES = 'ilink/bot/getupdates'
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage'
const EP_SEND_TYPING = 'ilink/bot/sendtyping'
const EP_GET_CONFIG = 'ilink/bot/getconfig'
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode'
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status'

const LONG_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
const CONFIG_TIMEOUT_MS = 10_000
const QR_TIMEOUT_MS = 35_000

const ITEM_TEXT = 1
const ITEM_IMAGE = 2
const ITEM_VOICE = 3
const ITEM_FILE = 4
const ITEM_VIDEO = 5
const MSG_TYPE_BOT = 2
const MSG_STATE_FINISH = 2

export const TYPING_START = 1
export const TYPING_STOP = 2

/** iLink error code meaning the bot session expired and needs a fresh QR login. */
export const SESSION_EXPIRED_ERRCODE = -14
/** iLink error code for frequency limiting. */
export const RATE_LIMIT_ERRCODE = -2

export interface IlinkItem {
  type?: number
  text_item?: { text?: string }
  ref_msg?: { title?: string; message_item?: IlinkItem }
  [key: string]: unknown
}

export interface IlinkMessage {
  from_user_id?: string
  to_user_id?: string
  message_id?: string
  message_type?: number
  context_token?: string
  room_id?: string
  chat_room_id?: string
  item_list?: IlinkItem[]
  [key: string]: unknown
}

export interface UpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msg?: string
  msgs?: IlinkMessage[]
  get_updates_buf?: string
  [key: string]: unknown
}

export interface IlinkAccount {
  account_id: string
  token: string
  base_url?: string
  user_id?: string
  saved_at?: string
}

export interface IlinkClientOptions {
  token: string
  baseUrl?: string
  /** Overrides for tests. */
  fetchImpl?: typeof fetch
}

function randomUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** A structural iLink failure: `ret`/`errcode` non-zero on an HTTP 200 response. */
export class IlinkApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly ret: number | undefined,
    readonly errcode: number | undefined,
    readonly errmsg: string | undefined,
  ) {
    super(`iLink ${endpoint} failed: ret=${String(ret)} errcode=${String(errcode)} errmsg=${errmsg ?? 'unknown error'}`)
    this.name = 'IlinkApiError'
  }

  get sessionExpired(): boolean {
    return this.errcode === SESSION_EXPIRED_ERRCODE || this.ret === SESSION_EXPIRED_ERRCODE
  }

  get rateLimited(): boolean {
    return this.errcode === RATE_LIMIT_ERRCODE || this.ret === RATE_LIMIT_ERRCODE
  }
}

/** Extract the model-visible text of one inbound item list, keeping quote context. */
export function extractText(itemList: readonly IlinkItem[] | undefined): string {
  const items = itemList ?? []
  for (const item of items) {
    if (item.type !== ITEM_TEXT) continue
    const text = String(item.text_item?.text ?? '')
    const ref = item.ref_msg
    const refItem = ref?.message_item
    if (refItem && [ITEM_IMAGE, ITEM_VIDEO, ITEM_FILE, ITEM_VOICE].includes(refItem.type ?? 0)) {
      const title = ref?.title ?? ''
      return title ? `[引用媒体: ${title}]\n${text}`.trim() : `[引用媒体]\n${text}`.trim()
    }
    if (refItem) {
      const parts = [ref?.title ?? '', extractText([refItem])].filter(Boolean)
      if (parts.length > 0) return `[引用: ${parts.join(' | ')}]\n${text}`.trim()
    }
    return text
  }
  for (const item of items) {
    if (item.type !== ITEM_VOICE) continue
    const voice = (item.voice_item ?? {}) as { text?: string; media?: unknown }
    if (!voice.media && voice.text) return `[Voice transcription provided by Weixin]\n${voice.text}`
  }
  return ''
}

/** Split outbound text on paragraph boundaries so one WeChat bubble stays readable. */
export function splitMessage(text: string, maxLength = 2000): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= maxLength) return [trimmed]

  const blocks = trimmed.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const block of blocks) {
    if (block.length > maxLength) {
      flush()
      for (let index = 0; index < block.length; index += maxLength) {
        chunks.push(block.slice(index, index + maxLength))
      }
      continue
    }
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length > maxLength) {
      flush()
      current = block
    } else {
      current = candidate
    }
  }
  flush()
  return chunks
}

/** One bot identity: token plus the base URL the login returned. */
export class IlinkClient {
  readonly baseUrl: string
  readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: IlinkClientOptions) {
    this.token = options.token
    this.baseUrl = (options.baseUrl || ILINK_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async call(
    endpoint: string,
    init: { method?: 'GET' | 'POST'; payload?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const timeoutMs = init.timeoutMs ?? API_TIMEOUT_MS
    const body = init.payload === undefined
      ? undefined
      : JSON.stringify({ ...init.payload, base_info: { channel_version: CHANNEL_VERSION } })
    const headers = body === undefined
      ? { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION }
      : requestHeaders(this.token)

    const response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
      method: init.method ?? 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`iLink ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`)
    }
    return JSON.parse(raw) as Record<string, unknown>
  }

  /**
   * Long-poll for inbound messages. A client-side timeout is not an error: iLink holds
   * the request open and returns empty, so callers simply poll again.
   */
  async getUpdates(syncBuf: string, timeoutMs = LONG_POLL_TIMEOUT_MS): Promise<UpdatesResponse> {
    try {
      return await this.call(EP_GET_UPDATES, { payload: { get_updates_buf: syncBuf }, timeoutMs }) as UpdatesResponse
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return { ret: 0, msgs: [], get_updates_buf: syncBuf }
      }
      throw error
    }
  }

  /** Send one text chunk. The caller owns chunking and retry policy. */
  async sendText(to: string, text: string, contextToken?: string): Promise<string> {
    if (!text.trim()) throw new Error('sendText: text must not be empty')
    const clientId = `dsh-weixin-${randomUUID()}`
    const message: Record<string, unknown> = {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    }
    if (contextToken) message.context_token = contextToken
    const response = await this.call(EP_SEND_MESSAGE, { payload: { msg: message } })
    const ret = response['ret'] as number | undefined
    const errcode = response['errcode'] as number | undefined
    const errmsg = (response['errmsg'] ?? response['msg']) as string | undefined
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      throw new IlinkApiError(EP_SEND_MESSAGE, ret, errcode, errmsg)
    }
    return clientId
  }

  /** Fetch the typing ticket required by `sendTyping`. */
  async getTypingTicket(userId: string, contextToken?: string): Promise<string> {
    const payload: Record<string, unknown> = { ilink_user_id: userId }
    if (contextToken) payload.context_token = contextToken
    const response = await this.call(EP_GET_CONFIG, { payload, timeoutMs: CONFIG_TIMEOUT_MS })
    return String(response['typing_ticket'] ?? '')
  }

  /** Show or clear the "typing…" indicator. Failures stay non-fatal. */
  async sendTyping(userId: string, ticket: string, status: number): Promise<void> {
    if (!ticket) return
    await this.call(EP_SEND_TYPING, {
      payload: { ilink_user_id: userId, typing_ticket: ticket, status },
      timeoutMs: CONFIG_TIMEOUT_MS,
    })
  }
}

export interface QrTicket {
  qrcode: string
  qrcodeUrl: string
}

/** Request a login QR code. `bot_type=3` is the personal WeChat / ClawBot path. */
export async function fetchQrTicket(botType = '3', baseUrl = ILINK_BASE_URL): Promise<QrTicket> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/${EP_GET_BOT_QR}?bot_type=${botType}`, {
    headers: { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION },
    signal: AbortSignal.timeout(QR_TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`iLink QR HTTP ${response.status}: ${raw.slice(0, 200)}`)
  const body = JSON.parse(raw) as Record<string, unknown>
  return { qrcode: String(body['qrcode'] ?? ''), qrcodeUrl: String(body['qrcode_img_content'] ?? '') }
}

export type QrStatus = 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed'

export interface QrStatusResponse {
  status: QrStatus | string
  redirectHost?: string
  accountId?: string
  token?: string
  baseUrl?: string
  userId?: string
}

/** Poll one QR login. The caller loops until it settles or times out. */
export async function pollQrStatus(qrcode: string, baseUrl = ILINK_BASE_URL): Promise<QrStatusResponse> {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`,
    {
      headers: { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION },
      signal: AbortSignal.timeout(QR_TIMEOUT_MS),
    },
  )
  const raw = await response.text()
  if (!response.ok) throw new Error(`iLink QR status HTTP ${response.status}: ${raw.slice(0, 200)}`)
  const body = JSON.parse(raw) as Record<string, unknown>
  return {
    status: String(body['status'] ?? 'wait'),
    redirectHost: body['redirect_host'] ? String(body['redirect_host']) : undefined,
    accountId: body['ilink_bot_id'] ? String(body['ilink_bot_id']) : undefined,
    token: body['bot_token'] ? String(body['bot_token']) : undefined,
    baseUrl: body['baseurl'] ? String(body['baseurl']) : undefined,
    userId: body['ilink_user_id'] ? String(body['ilink_user_id']) : undefined,
  }
}
