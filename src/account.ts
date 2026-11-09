/**
 * Account discovery: reuse the iLink bot credentials the Hermes weixin adapter saved.
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The subset of a saved iLink login this bridge needs. */
export interface IlinkAccount {
  account_id: string
  token: string
  base_url?: string
  user_id?: string
  saved_at?: string
}

function hermesHome(): string {
  return process.env['HERMES_HOME'] || join(homedir(), '.hermes')
}

async function readAccount(path: string): Promise<IlinkAccount | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as IlinkAccount
  } catch {
    return undefined
  }
}

/**
 * Resolve the login to poll.
 *
 * `WEIXIN_ACCOUNT_ID` and the plugin's `accountId` select a specific bot; without
 * either, the most recently paired account wins. Scanning the Hermes directory keeps
 * one WeChat contact: the ClawBot plugin allows a single paired bot per WeChat user,
 * so a second pairing would displace the first.
 *
 * @param accountId - configured bot identity, if any.
 * @returns the saved login, or undefined when the machine has never paired.
 */
export async function discoverAccount(accountId?: string): Promise<IlinkAccount | undefined> {
  const accountDir = join(hermesHome(), 'weixin', 'accounts')
  let names: string[]
  try {
    names = await readdir(accountDir)
  } catch {
    return undefined
  }

  const candidates: IlinkAccount[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.includes('.context') || name.includes('.sync')) continue
    const account = await readAccount(join(accountDir, name))
    if (account?.token === undefined) continue
    // The adapter stores the bot identity in the file name, not in the document.
    candidates.push({ ...account, account_id: account.account_id || name.slice(0, -'.json'.length) })
  }
  if (candidates.length === 0) return undefined

  const wanted = accountId || process.env['WEIXIN_ACCOUNT_ID']
  if (wanted) {
    const exact = candidates.find(candidate => candidate.account_id === wanted)
    if (exact) return exact
  }
  candidates.sort((left, right) => String(right.saved_at ?? '').localeCompare(String(left.saved_at ?? '')))
  return candidates[0]
}
