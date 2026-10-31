import { z } from 'zod'
import { compareAppVersions } from '../../../src/shared/app-version'
import type { AppUpdateCheckResult, AppUpdateSource } from './app-update-source'
import { isNewerReleaseVersion } from './app-update-source'

const REPO_API = 'https://api.github.com/repos/stablyai/orca'
// Use tag refs: newest-first release/Atom windows can fill with desktop releases and hide mobile updates; mobile-android releases all carry prerelease flag.
const TAG_PREFIX = 'mobile-android-v'
// Probe bounded older candidates: workflow tags before APK build, so failed build can leave unpublished tag.
const MAX_RELEASE_PROBES = 3

type Fetch = typeof fetch

const tagRefsSchema = z.array(z.looseObject({ ref: z.string() }))
const installableReleaseSchema = z.looseObject({
  draft: z.literal(false),
  html_url: z.string(),
  assets: z.array(z.looseObject({ name: z.string() }))
})

/** Versions named by the tag refs GitHub returns for the mobile-android prefix. */
export function parseMobileAndroidTagVersions(refs: unknown, tagPrefix = TAG_PREFIX): string[] {
  const prefix = `refs/tags/${tagPrefix}`
  return tagRefsSchema
    .parse(refs)
    .filter(({ ref }) => ref.startsWith(prefix))
    .map(({ ref }) => ref.slice(prefix.length))
}

/** The release page when the tag has a published release carrying an APK, else null. */
export function installableReleaseUrl(release: unknown): string | null {
  const parsed = installableReleaseSchema.safeParse(release)
  return parsed.success && parsed.data.assets.some((asset) => asset.name.endsWith('.apk'))
    ? parsed.data.html_url
    : null
}

/** Forca: a fork build reads its releases from its own repository and tag prefix. */
export type GithubReleaseChannel = { repoApi: string; tagPrefix: string }

export function createGithubReleaseUpdateSource(
  fetchImpl: Fetch,
  channel: GithubReleaseChannel = { repoApi: REPO_API, tagPrefix: TAG_PREFIX }
): AppUpdateSource {
  const { repoApi, tagPrefix } = channel
  return {
    async check(installedVersion, signal): Promise<AppUpdateCheckResult> {
      const refsReply = await fetchImpl(`${repoApi}/git/matching-refs/tags/${tagPrefix}`, {
        signal
      })
      if (!refsReply.ok) {
        throw new Error(`tag refs HTTP ${refsReply.status}`)
      }
      const candidates = parseMobileAndroidTagVersions(await refsReply.json(), tagPrefix)
        .filter((version) => isNewerReleaseVersion(version, installedVersion))
        .sort((left, right) => compareAppVersions(right, left))
        .slice(0, MAX_RELEASE_PROBES)
      for (const version of candidates) {
        const releaseReply = await fetchImpl(
          `${repoApi}/releases/tags/${encodeURIComponent(`${tagPrefix}${version}`)}`,
          { signal }
        )
        if (releaseReply.status === 404) {
          continue
        }
        if (!releaseReply.ok) {
          throw new Error(`release HTTP ${releaseReply.status}`)
        }
        const url = installableReleaseUrl(await releaseReply.json())
        if (url) {
          return { kind: 'available', version, url }
        }
      }
      return { kind: 'current' }
    }
  }
}

export const githubReleaseUpdateSource = createGithubReleaseUpdateSource((input, init) =>
  fetch(input, init)
)
