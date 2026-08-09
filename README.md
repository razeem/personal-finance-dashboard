# Personal Finance

A personal-finance dashboard built around **seven pillars** — Income, Spending, Saving, Loan,
Insurance, Investing and Tax — that share **one reactive model**: every value is entered once, in
the pillar that owns it, and computed everywhere else. Everything is persisted locally in
**IndexedDB** — no backend, no accounts.

Built with **Angular 22** (standalone, zoneless, signals), **Angular Material 3**, and **Tailwind CSS v4**.

## Prerequisites

- **Node ≥ 24.15** (Angular 22 CLI requirement). The repo pins `24.18.0`:
  ```bash
  nvm use            # reads .nvmrc
  npm install
  ```

## Development

| Command | Description |
| --- | --- |
| `npm start` | Dev server at http://localhost:4200 |
| `npm run build` | Production build → `dist/` (git-ignored) |
| `npm run build:pages` | Production build with `--base-href /personal-finance-dashboard/` (reproduces the deployed output locally) |
| `npm test` | Unit tests (Vitest); single run: `npx ng test --no-watch` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (write) |
| `npm run e2e` | Playwright end-to-end tests (first run: `npx playwright install chromium`) |

## Features

- **Dashboard** — the aggregate picture: gross/net/tax/surplus, an allocation bar, and pillar cards.
- **Income** — Minimum Income calculator (owns your Gross Income), Goals (must-have / good-to-have), and an ICER income-idea generator (rate ideas 1–5 on Interest, Capability, Effortlessness, Return; sortable).
- **Spending** — repeatable Needs and Wants lists that feed the shared model.
- **Tax** — Indian income-tax calculator (old & new regime) reading your shared Gross Income, plus a side-by-side **Regime Comparer**. Pure, unit-tested calculations.
- **Saving · Loan · Insurance · Investing** — routed placeholders (*Coming soon*), already wired into the model.
- **Shared model** — enter a value once; every dependent figure recomputes reactively across pillars.
- **Profile & settings** — top-right avatar → dialog with a profile form (photo compressed to WebP `<canvas>` → `Blob`) and theme preferences.
- **Excel export** — export tax and profile data to a real `.xlsx` (offline, via exceljs).

## Architecture & conventions

See [CLAUDE.md](CLAUDE.md) for the full architecture, the **persistence pattern** every tool follows (`StorageService` over IndexedDB with signal-backed collections and two-level versioning/migrations), and testing notes.

## Deployment

Pushing to `master` triggers `.github/workflows/deploy.yml`, which lints, runs unit + e2e tests, builds the site (base href set from the repo name), and publishes it to **GitHub Pages** via GitHub Actions — no build output is committed.

One-time setup: in the repo, **Settings → Pages → Source → "GitHub Actions"**. The site is served at `https://<owner>.github.io/<repo>/`.

## Support

If this saved you time, you can [buy me a coffee](https://buymeacoffee.com/razeem). Entirely optional — the app is free, offline-first, and keeps your data on your own device either way.
