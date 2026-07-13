---
name: GitHub push credential fallback
description: What to do when gitPush/gitPull callbacks fail with NO_CREDENTIALS / "no github-source-control credentials" even though git fetch works.
---

`git fetch`/`git pull` over HTTPS to a GitHub remote can succeed via Replit's ambient read-only git auth (GIT_ASKPASS) even when the account has no write-capable GitHub connection. The `gitPush`/`gitPull`/`createPullRequest` callbacks from the git-remote skill use a separate managed credential ("github-source-control") that only exists after the user authorizes the GitHub connector/Git-pane OAuth flow with write scope.

**Why:** Read access and write (push) access are backed by different credential sources in this environment; a successful fetch does not imply push will work.

**How to apply:** If the user declines/dismisses the GitHub connector `ProposeIntegration` (or the Git pane OAuth) and still wants to push, fall back to a user-supplied Personal Access Token:
1. Never accept the token pasted in chat — use `requestSecrets({ keys: ["GITHUB_PAT"] })`.
2. Push via an inline credential helper so the token is never echoed or logged: `git -c credential.helper='!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f' push origin <branch>`.
3. Persist it for future pushes/pulls in that repo with `git config credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f'` (repo-local `.git/config`, not committed).
This lets plain `git push`/`git pull` work going forward without re-invoking the managed `gitPush` callback (which will still report NO_CREDENTIALS since it doesn't consult repo-local credential helpers).
