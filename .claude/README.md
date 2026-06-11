# .claude config

Curated from [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) (cloned at `workspace/everything-claude-code`), selected for what we're building per `research/DESIGN.md`: a TypeScript monorepo (`@agentgraph/core|register|sdk`) doing OTel instrumentation, runnable on Node and Bun, verified against Jaeger via docker compose.

| Dir | Contents | Why |
|---|---|---|
| `rules/common/` | coding-style, testing, patterns, security, performance, git-workflow, code-review, development-workflow | language-agnostic baseline rules |
| `rules/typescript/` | all ECC TypeScript rules | the whole codebase is TS |
| `agents/` | typescript-reviewer, code-reviewer, security-reviewer, silent-failure-hunter, type-design-analyzer, tdd-guide, planner, code-architect, build-error-resolver, performance-optimizer | silent-failure-hunter matters specifically: the shim must never crash or alter the host app (DESIGN §3, Test B byte-identical gate); type-design-analyzer for the three public API surfaces; performance-optimizer for the hot-path fetch wrapper |
| `commands/` | /plan, /build-fix, /code-review, /test-coverage, /quality-gate, /pr | generic dev workflow |
| `skills/` | bun-runtime, tdd-workflow, verification-loop, error-handling, coding-standards, backend-patterns, docker-patterns, api-design | bun-runtime → DESIGN Q1; docker-patterns → Jaeger compose (Test infra); verification-loop/tdd-workflow → Phase 3 acceptance tests |

Deliberately NOT copied:

- `hooks/hooks.json` — every hook shells into ECC's plugin bootstrap (`scripts/hooks/plugin-hook-bootstrap.js` + `scripts/lib/utils.js`); nonfunctional without vendoring their whole `scripts/` tree.
- `rules/common/agents.md`, `rules/common/hooks.md` — describe ECC's own installation layout, not ours.
- Language/framework/domain content with no overlap (react/python/go/etc. rules, reviewers, build resolvers; marketing/healthcare/homelab/trading skills; orchestration/loop/GAN/PRP command suites).
