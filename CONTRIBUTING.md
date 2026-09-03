# Contributing to Blackbox

Thanks for helping improve Blackbox.

## Development requirements

- Node.js 24 or newer
- Git
- A temporary Git repository for CLI integration checks

Install dependencies and run the checks:

```sh
npm install
npm test
npm run lint
git diff --check
```

Before changing behavior, read `docs/PRD.md` and the relevant implementation
plan. Keep changes narrow, preserve unrelated working-tree changes, and do
not use destructive Git commands.

Blackbox is local-only. It must not capture hidden reasoning, credentials, or
modify Git commits, remotes, branches, or the index. Pull requests should
include tests and documentation for user-visible behavior.

## Pull requests

Describe the user problem, the behavior changed, verification commands, and
any remaining limitations. Small focused pull requests are easiest to review.
