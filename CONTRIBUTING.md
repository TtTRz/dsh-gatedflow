# Contributing

Thanks for your interest in dsh-gatedflow.

## Setup

```bash
git clone <repo-url> && cd dsh-gatedflow
npm install
npm run check   # build + typecheck + tests
```

Requires Node.js ≥ 20.

## Layout

```
packages/engine/        framework-agnostic engine core (zero deps)
packages/dsh-gatedflow/ DeepSeek Harness adapter (host + client halves)
docs/                   DESIGN + INTEGRATION
examples/subflows/      reference subflow definitions
```

## Quality bar

- **Engine changes need unit tests.** The runtime is exercised through the
  fake `ShellRunner` / `WorkflowStore` / `DeadlineTimer` in
  `packages/engine/test/`; add a scenario test for every new state
  transition.
- **TypeScript strict mode is on** (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). `npm run typecheck` must pass.
- **The engine stays framework-agnostic.** No DSH imports in
  `packages/engine`; every capability arrives through `EngineServices`.
- **Human decisions stay out of model channels.** Any change to the gate
  protocol must keep approve/reject out of the `gf_*` schemas and keep the
  guard in place.

## Conventions

- Commits follow conventional-commit style (`feat(engine): …`,
  `fix(dsh): …`, `docs: …`).
- Public engine APIs carry JSDoc; breaking changes bump a documented
  migration note in the PR description.
- Subflow examples in `examples/subflows` must pass `validateSubflow`.

## Releasing

1. `npm run check` green.
2. Bump both package versions together.
3. Tag `v<version>`; publish from each package's build output
   (`engine/dist`, `dsh-gatedflow/lib`).
