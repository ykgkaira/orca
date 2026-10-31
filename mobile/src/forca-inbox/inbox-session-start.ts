// Forca: start the session that YKG confirmed in the inbox, on the selected host.
// 1. Make a new workspace (worktree), if the selection asks for one.
// 2. Start Claude Code in the workspace with the prompt.

import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import {
  launchAgentInExistingWorkspace,
  reserveMobileAgentLaunch
} from '../session/mobile-existing-agent-launch'
import { createBlankWorkspace } from '../tasks/blank-workspace-create'
import { worktreeCreateCapabilityRead } from '../tasks/mobile-workspace-create-operations'
import { readNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'

export const INBOX_AGENT: TuiAgent = 'claude'

export type InboxStartTarget =
  | { kind: 'existing'; worktreeId: string; name: string }
  | { kind: 'new'; repoId: string; name: string }

export type InboxStartResult =
  | { ok: true; worktreeId: string; name: string; warning?: string }
  | { ok: false; message: string; worktreeId?: string; name?: string }

async function readHostCapabilities(client: RpcClient): Promise<readonly string[]> {
  const status = worktreeCreateCapabilityRead.interpret(
    await worktreeCreateCapabilityRead.request(client)
  )
  return status.accepted ? (status.value.capabilities ?? []) : []
}

export async function startInboxSession(args: {
  client: RpcClient
  target: InboxStartTarget
  prompt: string
}): Promise<InboxStartResult> {
  const { client, target } = args
  let worktreeId: string
  let name = target.name
  let warning: string | undefined

  if (target.kind === 'new') {
    const runtime = await readNewWorktreeRuntimeCapabilities(client)
    const created = await createBlankWorkspace({
      client,
      repoId: target.repoId,
      baseName: target.name,
      createdWithAgentId: undefined,
      comment: undefined,
      setupDecision: 'inherit',
      nameWasGenerated: false,
      worktreeCreateIdempotency: runtime?.worktreeCreateIdempotency ?? false,
      agentLaunchSupported: false
    })
    if ('error' in created) {
      return { ok: false, message: created.error }
    }
    worktreeId = created.worktreeId
    name = created.name
    warning = created.warning
  } else {
    worktreeId = target.worktreeId
  }

  const launched = await launchAgentInExistingWorkspace({
    client,
    hostCapabilities: await readHostCapabilities(client),
    worktreeId,
    agent: INBOX_AGENT,
    reservation: reserveMobileAgentLaunch(INBOX_AGENT),
    prompt: { text: args.prompt, delivery: 'submit' }
  })
  switch (launched.kind) {
    case 'launched':
      return launched.promptDelivered === false
        ? { ok: false, message: 'The agent started, but the prompt was not sent.', worktreeId, name }
        : { ok: true, worktreeId, name, ...(warning ? { warning } : {}) }
    case 'unsupported':
      return {
        ok: false,
        message: 'Update Orca on this host to start an agent from the phone.',
        worktreeId,
        name
      }
    default:
      return { ok: false, message: launched.message, worktreeId, name }
  }
}
