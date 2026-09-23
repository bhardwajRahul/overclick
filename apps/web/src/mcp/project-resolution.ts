/**
 * task_create finds the card's project from the repository the agent works in
 * (OCL-208), instead of making it read the whole project_list first to learn
 * which project that repository is. The agent sends what it already knows —
 * its git remote, owner/repo, or the path of its checkout — and this module
 * matches it against each project's repo_url. Pure: no database, so every rule
 * is tested on its own.
 *
 * Exact matches come first: a remote naming the same repository, or a path
 * inside a checkout registered as file://. Failing that, a folder of the path
 * (or a bare name) equal to a repository's name matches. Several projects at
 * the same step are returned as candidates, never picked from; task_create
 * says which step it took, so a card filed by a name in the wrong project is
 * visible in the answer instead of discovered later.
 */

/** The part of a project the matcher reads. */
export type RepoProject = {
  idPrefix: string;
  repoUrl: string | null;
};

/** remote: the same repository. path: inside its checkout. name: same folder name. */
export type RepoMatch = "remote" | "path" | "name";

/** What the caller sent, as the refusal describes it. */
export type RepoRefKind = "remote" | "path" | "name";

export type RepoResolution<P extends RepoProject> =
  | { kind: "resolved"; project: P; match: RepoMatch }
  | { kind: "ambiguous"; candidates: P[]; match: RepoMatch; sought: string }
  | {
      kind: "none";
      ref: RepoRefKind;
      /** Safe to echo: a remote keeps only owner/repo, never its host or credentials. */
      sought: string;
    }
  /** Neither a remote, a path nor a name. Not echoed: it may be a broken url with a token in it. */
  | { kind: "unreadable" };

type RepoRef = {
  kind: RepoRefKind;
  /** Lowercased, forward slashes, no trailing slash, no .git. */
  key: string;
  sought: string;
};

type ProjectKey = {
  kind: "remote" | "local";
  key: string;
  name: string;
};

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;
// user@host:owner/repo, the form git prints for an ssh remote.
const SCP_LIKE = /^(?:[^@\s/]+@)?[^:\s/]+:(?!\/)(.+)$/;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lastSegment(key: string): string {
  return key.split("/").filter(Boolean).pop() ?? "";
}

/** A local checkout: an absolute, home-relative or Windows path, or a file:// url. */
function localPath(value: string): string | null {
  let path = value;
  if (/^file:/i.test(path)) {
    try {
      path = decoded(new URL(path).pathname);
    } catch {
      return null;
    }
    // file:///C:/repo reads back as /C:/repo.
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  } else if (
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !path.startsWith("\\") &&
    !WINDOWS_DRIVE.test(path)
  ) {
    return null;
  }
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
}

/**
 * The repository path of a remote, host dropped: ssh, https and a host alias
 * from ~/.ssh/config all name the same owner/repo. Null when it holds no path.
 */
function remotePath(value: string): string | null {
  let path: string;
  if (SCHEME.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return null;
    }
  } else {
    const scp = SCP_LIKE.exec(value);
    if (scp?.[1]) {
      path = scp[1];
    } else {
      // github.com/owner/repo: a first segment with a dot is the host.
      const [first, ...rest] = value.split("/");
      path = first?.includes(".") && rest.length > 0 ? rest.join("/") : value;
    }
  }
  const clean = decoded(path)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  return clean || null;
}

function parseRepo(raw: string): RepoRef | null {
  const value = raw.trim();
  if (!value) return null;
  const local = localPath(value);
  if (local) return { kind: "path", key: local.toLowerCase(), sought: local };
  if (value.includes("/") || value.includes(":")) {
    const path = remotePath(value);
    if (!path) return null;
    return path.includes("/")
      ? { kind: "remote", key: path.toLowerCase(), sought: path }
      : { kind: "name", key: path.toLowerCase(), sought: path };
  }
  return { kind: "name", key: value.toLowerCase(), sought: value };
}

function projectKey(repoUrl: string | null): ProjectKey | null {
  const value = repoUrl?.trim();
  if (!value) return null;
  const local = localPath(value);
  if (local) {
    const key = local.toLowerCase();
    return { kind: "local", key, name: lastSegment(key) };
  }
  const path = remotePath(value);
  if (!path?.includes("/")) return null;
  const key = path.toLowerCase();
  return { kind: "remote", key, name: lastSegment(key) };
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function decide<P extends RepoProject>(
  hits: Array<{ project: P }>,
  match: RepoMatch,
  sought: string,
): RepoResolution<P> {
  const [only] = hits;
  if (hits.length === 1 && only) return { kind: "resolved", project: only.project, match };
  return {
    kind: "ambiguous",
    candidates: hits.map((hit) => hit.project),
    match,
    sought,
  };
}

export function resolveProjectByRepo<P extends RepoProject>(
  repo: string,
  projects: readonly P[],
): RepoResolution<P> {
  const ref = parseRepo(repo);
  if (!ref) return { kind: "unreadable" };

  const keyed = projects.flatMap((project) => {
    const key = projectKey(project.repoUrl);
    return key ? [{ project, key }] : [];
  });

  // The same repository, or a path inside a registered checkout. The innermost
  // one wins, the way git finds the nearest .git.
  if (ref.kind !== "name") {
    const kind = ref.kind === "remote" ? "remote" : "local";
    const inside = keyed.filter(
      ({ key }) => key.kind === kind && within(ref.key, key.key),
    );
    if (inside.length > 0) {
      const depth = Math.max(...inside.map(({ key }) => key.key.length));
      return decide(
        inside.filter(({ key }) => key.key.length === depth),
        ref.kind === "remote" ? "remote" : "path",
        ref.sought,
      );
    }
  }

  // By name. A remote only reaches checkouts registered by path: two remotes
  // that differ are two repositories. A path tries its folders from the
  // deepest up, so a worktree (repo/.worktrees/x) finds the repository that
  // holds it.
  const pool =
    ref.kind === "remote" ? keyed.filter(({ key }) => key.kind === "local") : keyed;
  const names =
    ref.kind === "path"
      ? ref.key.split("/").filter(Boolean).reverse()
      : [lastSegment(ref.key)];
  for (const name of names) {
    const hits = pool.filter(({ key }) => key.name === name);
    if (hits.length > 0) return decide(hits, "name", ref.sought);
  }
  return { kind: "none", ref: ref.kind, sought: ref.sought };
}
