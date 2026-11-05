import { APP_VERSION, DEFAULT_USER_AGENT } from "../const";

const LATEST_RELEASE_API =
  "https://api.github.com/repos/gnutonium/Gnutonium/releases/latest";
const UPDATE_MESSAGE =
  "A new version of Gnutonium is available: https://github.com/gnutonium/Gnutonium/releases/latest";
const UPDATE_TIMEOUT_MS = 2000;

type ReleaseVersion = { major: number; minor: number };
type UpdateCheckOptions = {
  currentVersion?: string;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
};

function releaseVersion(value: unknown): ReleaseVersion | undefined {
  if (typeof value !== "string") return;
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return;
  return { major, minor };
}

function publishedVersion(value: unknown): ReleaseVersion | undefined {
  if (typeof value !== "object" || value === null) return;
  if (!("tag_name" in value)) return;
  if (!("draft" in value) || value.draft !== false) return;
  if (!("prerelease" in value) || value.prerelease !== false) return;
  return releaseVersion(value.tag_name);
}

function newerRelease(value: unknown, current: ReleaseVersion): boolean {
  const latest = publishedVersion(value);
  if (!latest) return false;
  return (
    latest.major > current.major ||
    (latest.major === current.major && latest.minor > current.minor)
  );
}

/** Best-effort startup notice; callers can run this without delaying the CLI. */
export async function notifyOfUpdate(
  log: (message: string) => void,
  options: UpdateCheckOptions = {},
): Promise<void> {
  const current = releaseVersion(options.currentVersion ?? APP_VERSION);
  if (!current) return;
  try {
    const response = await (options.fetchImpl ?? fetch)(
      LATEST_RELEASE_API,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": DEFAULT_USER_AGENT,
        },
        signal: AbortSignal.timeout(
          options.timeoutMs ?? UPDATE_TIMEOUT_MS,
        ),
      },
    );
    if (!response.ok) return;
    const release: unknown = await response.json();
    if (newerRelease(release, current)) log(UPDATE_MESSAGE);
  } catch {
    // Offline, rate-limited, and invalid responses should never disturb startup.
  }
}
