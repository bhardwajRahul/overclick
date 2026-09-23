import { describe, expect, it } from "vitest";
import { resolveProjectByRepo, type RepoProject } from "./project-resolution";

function projects(...rows: Array<[string, string | null]>): RepoProject[] {
  return rows.map(([idPrefix, repoUrl]) => ({ idPrefix, repoUrl }));
}

function prefixOf(repo: string, rows: RepoProject[]) {
  const found = resolveProjectByRepo(repo, rows);
  return found.kind === "resolved"
    ? { prefix: found.project.idPrefix, match: found.match }
    : found.kind;
}

describe("resolveProjectByRepo (OCL-208)", () => {
  const board = projects(
    ["OVKA", "https://github.com/ustoppble/overclock-app"],
    ["OCL", "https://github.com/ustoppble/overclick.git"],
    ["SITE", "git@github.com:ustoppble/overclock-web.git"],
    ["LAB", "file:///Users/me/Developer/lab"],
    ["LABX", "file:///Users/me/Developer/lab/experiments/x"],
    ["MKT", null],
  );

  it("matches the git remote in every form git prints it", () => {
    for (const remote of [
      "https://github.com/ustoppble/overclick",
      "https://github.com/ustoppble/overclick.git",
      "git@github.com:ustoppble/overclick.git",
      "ssh://git@github.com/ustoppble/overclick.git",
      "github.com/ustoppble/overclick",
      "ustoppble/overclick",
      "  HTTPS://GitHub.com/UStoppble/OverClick/  ",
    ]) {
      expect(prefixOf(remote, board)).toEqual({ prefix: "OCL", match: "remote" });
    }
    // A project stored as ssh answers an https remote, and the other way round.
    expect(prefixOf("https://github.com/ustoppble/overclock-web", board)).toEqual({
      prefix: "SITE",
      match: "remote",
    });
    // An ssh host alias from ~/.ssh/config still names the same repository.
    expect(prefixOf("git@github-work:ustoppble/overclock-app.git", board)).toEqual({
      prefix: "OVKA",
      match: "remote",
    });
  });

  it("matches a web link to a file inside the repository", () => {
    expect(
      prefixOf("https://github.com/ustoppble/overclock-app/tree/main/packages", board),
    ).toEqual({ prefix: "OVKA", match: "remote" });
  });

  it("matches a path inside a checkout registered as file://, the innermost first", () => {
    expect(prefixOf("/Users/me/Developer/lab", board)).toEqual({ prefix: "LAB", match: "path" });
    expect(prefixOf("/Users/me/Developer/lab/src/deep", board)).toEqual({
      prefix: "LAB",
      match: "path",
    });
    expect(prefixOf("/Users/me/Developer/lab/experiments/x/.worktrees/w1", board)).toEqual({
      prefix: "LABX",
      match: "path",
    });
    expect(prefixOf("file:///Users/me/Developer/lab/", board)).toEqual({
      prefix: "LAB",
      match: "path",
    });
    // A sibling whose name only starts the same is another folder.
    expect(prefixOf("/Users/me/Developer/lab-2", board)).toBe("none");
  });

  it("matches the folder of a path against the repository name, the deepest folder first", () => {
    expect(prefixOf("/Users/me/code/overclock-app", board)).toEqual({
      prefix: "OVKA",
      match: "name",
    });
    // A worktree lives inside the repository it belongs to.
    expect(prefixOf("/Users/me/code/overclock-app/.worktrees/dev-1324", board)).toEqual({
      prefix: "OVKA",
      match: "name",
    });
    expect(prefixOf("~/code/overclick", board)).toEqual({ prefix: "OCL", match: "name" });
    expect(prefixOf("C:\\Users\\me\\code\\Overclock-App\\", board)).toEqual({
      prefix: "OVKA",
      match: "name",
    });
  });

  it("matches a bare name against the repository name", () => {
    expect(prefixOf("overclick", board)).toEqual({ prefix: "OCL", match: "name" });
    expect(prefixOf("lab", board)).toEqual({ prefix: "LAB", match: "name" });
  });

  it("lets a remote reach a checkout registered by path through its name, never another remote", () => {
    // The lab checkout is registered by path; its remote names the same folder.
    expect(prefixOf("git@github.com:me/lab.git", board)).toEqual({
      prefix: "LAB",
      match: "name",
    });
    // Two remotes that differ are two repositories, whatever their names.
    expect(prefixOf("https://github.com/someone-else/overclick", board)).toBe("none");
  });

  it("matches Windows paths and file:// urls of them", () => {
    const windows = projects(["WIN", "file:///C:/Users/me/repo%20one"]);
    expect(prefixOf("C:\\Users\\me\\repo one\\src", windows)).toEqual({
      prefix: "WIN",
      match: "path",
    });
    expect(prefixOf("c:/users/me/repo one", windows)).toEqual({
      prefix: "WIN",
      match: "path",
    });
  });

  it("returns the candidates, and only them, when several projects match", () => {
    const twins = projects(
      ["A1", "https://github.com/acme/web"],
      ["A2", "https://github.com/acme/web.git"],
      ["B", "https://github.com/other/web"],
      ["C", "https://github.com/acme/api"],
    );
    const same = resolveProjectByRepo("git@github.com:acme/web.git", twins);
    expect(same.kind).toBe("ambiguous");
    if (same.kind !== "ambiguous") return;
    expect(same.match).toBe("remote");
    expect(same.candidates.map((row) => row.idPrefix)).toEqual(["A1", "A2"]);

    const byName = resolveProjectByRepo("/srv/checkouts/web", twins);
    expect(byName.kind).toBe("ambiguous");
    if (byName.kind !== "ambiguous") return;
    expect(byName.match).toBe("name");
    expect(byName.candidates.map((row) => row.idPrefix)).toEqual(["A1", "A2", "B"]);
  });

  it("says what it looked for when nothing matches, without echoing credentials", () => {
    const missing = resolveProjectByRepo(
      "https://x-access-token:s3cr3t@github.com/ustoppble/unknown.git",
      board,
    );
    expect(missing).toEqual({ kind: "none", ref: "remote", sought: "ustoppble/unknown" });
    expect(JSON.stringify(missing)).not.toContain("s3cr3t");

    expect(resolveProjectByRepo("/tmp/nowhere/at-all", board)).toEqual({
      kind: "none",
      ref: "path",
      sought: "/tmp/nowhere/at-all",
    });
    expect(resolveProjectByRepo("nothing-here", board)).toEqual({
      kind: "none",
      ref: "name",
      sought: "nothing-here",
    });
    // A url that does not parse is not repeated back: it may carry a token.
    expect(resolveProjectByRepo("https://user:s3cr3t@", board)).toEqual({
      kind: "unreadable",
    });
  });

  it("ignores projects without a repo_url and repo_urls it cannot read", () => {
    const rows = projects(["MKT", null], ["ODD", "not a url"], ["OK", "https://github.com/a/b"]);
    expect(prefixOf("a/b", rows)).toEqual({ prefix: "OK", match: "remote" });
    expect(prefixOf("mkt", rows)).toBe("none");
  });
});
