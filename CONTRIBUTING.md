# Contributing

Thanks for helping improve bugtoprompt.

## Prerequisites

- **Node** >= 18
- **pnpm**

## Setup

```bash
pnpm install
```

## Verification

Every PR must pass all four:

```bash
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm build       # tsup
```

CI (the **CI** GitHub Actions workflow) runs these on every PR. Running
them locally first keeps the loop fast.

## Code style

Formatting and linting are handled by **biome** — tabs, double quotes. Before
committing:

```bash
pnpm exec biome check --write .
```

English only in code and comments.

## Commits & PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, ...).
- Keep PRs focused — one logical change per PR.
- Add tests for behavior changes.

## Questions

Open an issue or a discussion on
[github.com/aryrabelo/bugtoprompt](https://github.com/aryrabelo/bugtoprompt).
