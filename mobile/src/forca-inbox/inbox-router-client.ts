// Forca: the client for the inbox router on ykgserv (forca/router/router.mjs in ykgkaira/forca).
// The router only selects a host, a project and a workspace. The phone starts the session itself.

import * as SecureStore from 'expo-secure-store'
import { z } from 'zod'

const URL_KEY = 'forca.inbox.routerUrl'
const TOKEN_KEY = 'forca.inbox.routerToken'
export const DEFAULT_ROUTER_URL = 'http://100.123.120.86:8790'
const ROUTE_TIMEOUT_MS = 120_000
const ENSURE_TIMEOUT_MS = 90_000

export type InboxRouterSettings = { url: string; token: string }

export async function loadInboxRouterSettings(): Promise<InboxRouterSettings> {
  const [url, token] = await Promise.all([
    SecureStore.getItemAsync(URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY)
  ])
  return { url: url?.trim() || DEFAULT_ROUTER_URL, token: token?.trim() ?? '' }
}

export async function saveInboxRouterSettings(settings: InboxRouterSettings): Promise<void> {
  await SecureStore.setItemAsync(URL_KEY, settings.url.trim() || DEFAULT_ROUTER_URL)
  await SecureStore.setItemAsync(TOKEN_KEY, settings.token.trim())
}

/** One host as the phone sees it now. The router copies IDs only from this data. */
export type InboxHostSnapshot = {
  hostId: string
  name: string
  platform: string | null
  online: boolean
  repos: { id: string; name: string; path: string | null }[]
  worktrees: {
    id: string
    repoId: string
    name: string
    branch: string
    path: string | null
    lastActivityAt: number | null
  }[]
}

export const inboxRouteResultSchema = z.object({
  hostId: z.string(),
  projectSlug: z.string(),
  repoId: z.string().nullable(),
  projectPath: z.string().nullable(),
  workspace: z.object({
    kind: z.enum(['existing', 'new', 'folder']),
    worktreeId: z.string().nullable(),
    name: z.string().nullable()
  }),
  reasons: z.object({ host: z.string(), project: z.string(), workspace: z.string() })
})

export type InboxRouteResult = z.infer<typeof inboxRouteResultSchema>

async function post(
  settings: InboxRouterSettings,
  route: string,
  body: unknown,
  timeoutMs: number
): Promise<unknown> {
  if (!settings.token) {
    throw new Error('Set the router token first.')
  }
  const reply = await fetch(`${settings.url.replace(/\/+$/, '')}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const json: unknown = await reply.json().catch(() => null)
  if (!reply.ok) {
    const message =
      json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
        ? json.error
        : `HTTP ${reply.status}`
    throw new Error(`Router: ${message}`)
  }
  return json
}

export async function requestInboxRoute(
  settings: InboxRouterSettings,
  prompt: string,
  hosts: InboxHostSnapshot[]
): Promise<InboxRouteResult> {
  return inboxRouteResultSchema.parse(
    await post(settings, '/route', { prompt, hosts }, ROUTE_TIMEOUT_MS)
  )
}

/** ykgserv adds the project on the host as a paired runtime client. The phone cannot call repo.add. */
export async function requestEnsureProject(
  settings: InboxRouterSettings,
  hostName: string,
  path: string
): Promise<{ repoId: string; added: boolean }> {
  return z
    .object({ repoId: z.string(), added: z.boolean() })
    .parse(await post(settings, '/ensure-project', { hostName, path }, ENSURE_TIMEOUT_MS))
}
