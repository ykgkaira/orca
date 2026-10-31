// Forca: the inbox. YKG writes one prompt. The router on ykgserv selects a host, a project and
// a workspace. YKG confirms or changes the selection. Then the phone starts the session.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Server, Settings2 } from 'lucide-react-native'
import { hostRepoCatalogRead } from '../host-screen/host-screen-operations'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import type { HostProfile } from '../transport/types'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  loadInboxRouterSettings,
  requestEnsureProject,
  requestInboxRoute,
  saveInboxRouterSettings,
  type InboxHostSnapshot,
  type InboxRouteResult,
  type InboxRouterSettings
} from './inbox-router-client'
import { startInboxSession } from './inbox-session-start'

type Phase =
  | { kind: 'compose' }
  | { kind: 'routing' }
  | { kind: 'review' }
  | { kind: 'starting'; step: string }

type Selection = {
  hostId: string
  repoId: string | null
  projectSlug: string
  projectPath: string | null
  workspace: { kind: 'existing'; worktreeId: string } | { kind: 'new'; name: string }
}

function readRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : []
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

async function readHostSnapshot(
  profile: HostProfile,
  client: RpcClient | null,
  online: boolean
): Promise<InboxHostSnapshot> {
  const base: InboxHostSnapshot = {
    hostId: profile.id,
    name: profile.personalName || profile.name,
    platform: profile.lastKnownHostPlatform ?? null,
    online,
    repos: [],
    worktrees: []
  }
  if (!client || !online) {
    return base
  }
  const [repoReply, worktreeReply] = await Promise.all([
    hostRepoCatalogRead.request(client).catch(() => null),
    worktreeCatalogRead.request(client, { limit: WORKTREE_PS_FULL_LIMIT }).catch(() => null)
  ])
  const repos = repoReply ? hostRepoCatalogRead.interpret(repoReply) : null
  if (repos?.accepted) {
    base.repos = repos.value.map((r) => ({ id: r.id, name: r.displayName, path: r.path ?? null }))
  }
  const catalog = worktreeReply ? worktreeCatalogRead.interpret(worktreeReply) : null
  if (catalog?.accepted) {
    base.worktrees = readRows(catalog.value.worktrees).flatMap((row) => {
      const id = str(row.worktreeId)
      const repoId = str(row.repoId)
      if (!id || !repoId) return []
      return [
        {
          id,
          repoId,
          name: str(row.displayName) ?? str(row.branch) ?? id,
          branch: str(row.branch) ?? '',
          path: str(row.path),
          lastActivityAt: typeof row.lastActivityAt === 'number' ? row.lastActivityAt : null
        }
      ]
    })
  }
  return base
}

function selectionFromRoute(route: InboxRouteResult): Selection {
  return {
    hostId: route.hostId,
    repoId: route.repoId,
    projectSlug: route.projectSlug,
    projectPath: route.projectPath,
    workspace:
      route.workspace.kind === 'existing' && route.workspace.worktreeId
        ? { kind: 'existing', worktreeId: route.workspace.worktreeId }
        : { kind: 'new', name: route.workspace.name || 'inbox' }
  }
}

function Chip(props: { label: string; selected: boolean; onPress: () => void; muted?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[styles.chip, props.selected && styles.chipSelected]}
    >
      <Text
        style={[
          styles.chipText,
          props.selected && styles.chipTextSelected,
          props.muted && styles.chipTextMuted
        ]}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}

export function InboxScreen() {
  useMobileColorScheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [profiles, setProfiles] = useState<HostProfile[]>([])
  const [settings, setSettings] = useState<InboxRouterSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' })
  const [error, setError] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<InboxHostSnapshot[]>([])
  const [route, setRoute] = useState<InboxRouteResult | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)

  useFocusEffect(
    useCallback(() => {
      void loadHostCatalog().then((catalog) =>
        setProfiles(selectConnectableHostProfiles(catalog))
      )
    }, [])
  )
  useEffect(() => {
    void loadInboxRouterSettings().then((loaded) => {
      setSettings(loaded)
      if (!loaded.token) setShowSettings(true)
    })
  }, [])

  const hostIds = useMemo(() => profiles.map((p) => p.id), [profiles])
  const clients = useAllHostClients(hostIds)
  const clientFor = useCallback(
    (hostId: string) => clients.find((c) => c.hostId === hostId) ?? null,
    [clients]
  )

  const onRoute = useCallback(async () => {
    const text = prompt.trim()
    if (!text || !settings) return
    setError(null)
    setPhase({ kind: 'routing' })
    try {
      const snaps = await Promise.all(
        profiles.map((p) => {
          const c = clientFor(p.id)
          return readHostSnapshot(p, c?.client ?? null, c?.state === 'connected')
        })
      )
      setSnapshots(snaps)
      if (!snaps.some((s) => s.online)) {
        throw new Error('No paired host is online.')
      }
      const result = await requestInboxRoute(settings, text, snaps)
      setRoute(result)
      setSelection(selectionFromRoute(result))
      setPhase({ kind: 'review' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase({ kind: 'compose' })
    }
  }, [prompt, settings, profiles, clientFor])

  const onStart = useCallback(async () => {
    if (!selection || !settings) return
    const host = snapshots.find((s) => s.hostId === selection.hostId)
    const conn = clientFor(selection.hostId)
    if (!host || !conn) {
      setError('The selected host is not connected.')
      return
    }
    setError(null)
    try {
      let repoId = selection.repoId
      if (!repoId) {
        if (!selection.projectPath) {
          throw new Error('The router does not know the path of this project on this host.')
        }
        setPhase({ kind: 'starting', step: `Adding ${selection.projectSlug} on ${host.name}…` })
        repoId = (await requestEnsureProject(settings, host.name, selection.projectPath)).repoId
      }
      setPhase({ kind: 'starting', step: 'Starting the session…' })
      const existing =
        selection.workspace.kind === 'existing'
          ? host.worktrees.find(
              (w) => selection.workspace.kind === 'existing' && w.id === selection.workspace.worktreeId
            )
          : undefined
      const result = await startInboxSession({
        client: conn.client,
        prompt: prompt.trim(),
        target: existing
          ? { kind: 'existing', worktreeId: existing.id, name: existing.name }
          : {
              kind: 'new',
              repoId,
              name: selection.workspace.kind === 'new' ? selection.workspace.name : 'inbox'
            }
      })
      if (!result.ok) {
        setError(result.message)
        if (!result.worktreeId) {
          setPhase({ kind: 'review' })
          return
        }
      }
      const worktreeId = result.worktreeId
      const name = result.name ?? 'session'
      if (worktreeId) {
        setPrompt('')
        setPhase({ kind: 'compose' })
        router.push(
          hostNewWorktreeSessionRoute(
            selection.hostId,
            worktreeId,
            name,
            result.ok ? result.warning : undefined
          )
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase({ kind: 'review' })
    }
  }, [selection, settings, snapshots, clientFor, prompt, router])

  const selectedHost = snapshots.find((s) => s.hostId === selection?.hostId)
  const reposOnHost = selectedHost?.repos ?? []
  const worktreesOfRepo = selectedHost?.worktrees.filter((w) => w.repoId === selection?.repoId) ?? []
  const busy = phase.kind === 'routing' || phase.kind === 'starting'

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top + spacing.sm }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.topRow}>
        <Text style={styles.heading}>Inbox</Text>
        <View style={styles.topActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hosts"
            style={styles.iconButton}
            onPress={() => router.push('/hosts')}
          >
            <Server size={20} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Inbox settings"
            style={styles.iconButton}
            onPress={() => setShowSettings((v) => !v)}
          >
            <Settings2 size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}>
        {showSettings && settings ? (
          <View style={styles.card}>
            <Text style={styles.label}>Router URL</Text>
            <TextInput
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              value={settings.url}
              onChangeText={(url) => setSettings({ ...settings, url })}
            />
            <Text style={styles.label}>Router token</Text>
            <TextInput
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              value={settings.token}
              onChangeText={(token) => setSettings({ ...settings, token })}
            />
            <Pressable
              accessibilityRole="button"
              style={styles.secondaryButton}
              onPress={() => {
                void saveInboxRouterSettings(settings).then(() => setShowSettings(false))
              }}
            >
              <Text style={styles.secondaryButtonText}>Save</Text>
            </Pressable>
          </View>
        ) : null}

        <TextInput
          style={[styles.input, styles.prompt]}
          multiline
          placeholder="What do you want to do?"
          placeholderTextColor={colors.textMuted}
          value={prompt}
          editable={!busy}
          onChangeText={(text) => {
            setPrompt(text)
            if (phase.kind === 'review') setPhase({ kind: 'compose' })
          }}
        />

        {phase.kind === 'compose' ? (
          <Pressable
            accessibilityRole="button"
            disabled={!prompt.trim() || !settings?.token}
            style={[styles.primaryButton, (!prompt.trim() || !settings?.token) && styles.disabled]}
            onPress={() => void onRoute()}
          >
            <Text style={styles.primaryButtonText}>Send</Text>
          </Pressable>
        ) : null}

        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color={colors.textSecondary} />
            <Text style={styles.meta}>
              {phase.kind === 'starting' ? phase.step : 'Choosing a host, project and workspace…'}
            </Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {phase.kind === 'review' && selection && route ? (
          <View style={styles.card}>
            <Text style={styles.label}>Host</Text>
            <View style={styles.chipRow}>
              {snapshots.map((s) => (
                <Chip
                  key={s.hostId}
                  label={s.online ? s.name : `${s.name} (offline)`}
                  muted={!s.online}
                  selected={s.hostId === selection.hostId}
                  onPress={() => {
                    if (!s.online) return
                    const sameName = s.repos.find(
                      (r) => r.name.toLowerCase() === selection.projectSlug.toLowerCase()
                    )
                    setSelection({
                      ...selection,
                      hostId: s.hostId,
                      repoId: sameName?.id ?? null,
                      projectPath: s.hostId === route.hostId ? route.projectPath : (sameName?.path ?? null),
                      workspace: {
                        kind: 'new',
                        name: route.workspace.name || 'inbox'
                      }
                    })
                  }}
                />
              ))}
            </View>
            <Text style={styles.reason}>{route.reasons.host}</Text>

            <Text style={styles.label}>Project</Text>
            <View style={styles.chipRow}>
              {selection.repoId === null ? (
                <Chip label={`${selection.projectSlug} (add)`} selected onPress={() => {}} />
              ) : null}
              {reposOnHost.map((r) => (
                <Chip
                  key={r.id}
                  label={r.name}
                  selected={r.id === selection.repoId}
                  onPress={() =>
                    setSelection({
                      ...selection,
                      repoId: r.id,
                      projectSlug: r.name,
                      projectPath: r.path,
                      workspace: {
                        kind: 'new',
                        name: route.workspace.name || 'inbox'
                      }
                    })
                  }
                />
              ))}
            </View>
            <Text style={styles.reason}>{route.reasons.project}</Text>

            <Text style={styles.label}>Workspace</Text>
            <View style={styles.chipRow}>
              <Chip
                label="New"
                selected={selection.workspace.kind === 'new'}
                onPress={() =>
                  setSelection({
                    ...selection,
                    workspace: { kind: 'new', name: route.workspace.name || 'inbox' }
                  })
                }
              />
              {worktreesOfRepo.map((w) => (
                <Chip
                  key={w.id}
                  label={w.name}
                  selected={
                    selection.workspace.kind === 'existing' &&
                    selection.workspace.worktreeId === w.id
                  }
                  onPress={() =>
                    setSelection({ ...selection, workspace: { kind: 'existing', worktreeId: w.id } })
                  }
                />
              ))}
            </View>
            {selection.workspace.kind === 'new' ? (
              <TextInput
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                value={selection.workspace.name}
                onChangeText={(name) =>
                  setSelection({ ...selection, workspace: { kind: 'new', name } })
                }
              />
            ) : null}
            <Text style={styles.reason}>{route.reasons.workspace}</Text>

            <View style={styles.buttonRow}>
              <Pressable
                accessibilityRole="button"
                style={styles.secondaryButton}
                onPress={() => setPhase({ kind: 'compose' })}
              >
                <Text style={styles.secondaryButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.primaryButton, styles.grow]}
                onPress={() => void onStart()}
              >
                <Text style={styles.primaryButtonText}>Start</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingHorizontal: spacing.lg },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.lg
  },
  topActions: { flexDirection: 'row', gap: spacing.sm },
  heading: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm
  },
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    marginTop: spacing.sm
  },
  input: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  prompt: { minHeight: 120, textAlignVertical: 'top', marginBottom: spacing.md },
  primaryButton: {
    backgroundColor: colors.accentBlue,
    borderRadius: radii.control,
    paddingVertical: spacing.md,
    alignItems: 'center'
  },
  primaryButtonText: { color: colors.onAccent, fontSize: typography.bodySize, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center'
  },
  secondaryButtonText: { color: colors.textPrimary, fontSize: typography.bodySize },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  grow: { flex: 1 },
  disabled: { opacity: 0.5 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.md },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize },
  error: { color: colors.statusRed, fontSize: typography.bodySize, marginVertical: spacing.md },
  reason: { color: colors.textMuted, fontSize: typography.metaSize },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    maxWidth: '100%'
  },
  chipSelected: { backgroundColor: colors.accentBlue, borderColor: colors.accentBlue },
  chipText: { color: colors.textPrimary, fontSize: typography.metaSize },
  chipTextSelected: { color: colors.onAccent },
  chipTextMuted: { color: colors.textMuted }
}))
