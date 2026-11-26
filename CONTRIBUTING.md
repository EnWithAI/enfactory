# Contributing

Thanks for trying enfactory. Issues, ideas and pull requests are welcome.

## Ask or share
- **Questions, ideas and things you built with it:** [Discussions](https://github.com/EnWithAI/enfactory/discussions).
- **Bugs:** open an issue with what you ran, what you expected, what happened, and the relevant lines from
  `memory/ledger/*.jsonl` or the dashboard. Never paste tokens, API keys or a client's data.

## Change the code
1. Fork the repo and create a branch from `main`.
2. `npm install`, then `npm test`. All tests must pass.
3. Keep changes small and focused. Match the surrounding code's style and comment density.
4. Add or update a test in `tests/` for any behaviour change.
5. Dependencies: latest stable versions only, and `npm audit --audit-level=moderate` must report nothing.
6. Open a pull request that says what changed and why.

## What lives where
- `factory/lib/`: the dispatcher, workers, dashboard and tools. This is the factory's code.
- `templates/org/`: the starting org (teams, charters, roles) for a new install.
- `org/`, `memory/`, `library/`: one install's own data. Git ignores them; never commit them.

Good places to start are issues labelled [good first issue](https://github.com/EnWithAI/enfactory/labels/good%20first%20issue).

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
