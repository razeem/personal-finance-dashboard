# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain

- **Angular 22** (standalone, **zoneless**, signal-based), **Angular Material 3 (M3)**, **Tailwind CSS v4**.
- Requires **Node ≥ 24.15** (Angular 22 CLI engine constraint). The pinned version is in `.nvmrc` (`24.18.0`); run `nvm use` before any `npm`/`ng` command. Node 24.12 and below will not run the CLI.
- Unit tests run on **Vitest** (via `@angular/build:unit-test`), not Karma. E2E is **Playwright**.

## Commands

- `npm start` — dev server at `http://localhost:4200/`.
- `npm run build` — production build → `dist/browser/` (git-ignored). Base href `/`. **Statically prerendered (SSG)** — see Deployment.
- `npm run build:pages` — production build with `--base-href /personal-finance-dashboard/`, matching how CI builds for GitHub Pages (the site is served from that subpath; a plain `build` bakes in a `/` base href that breaks assets there). Useful for locally reproducing the deployed output.
- `npm test` — Vitest unit tests (watch). Single run: `npx ng test --no-watch`. Filter: `npx ng test --no-watch --include='**/income-tax.model.spec.ts'` (pattern support depends on the builder; the pure-logic specs are the fast ones).
- `npm run lint` — ESLint (flat config, `eslint.config.js`).
- `npm run format` / `npm run format:check` — Prettier.
- `npm run e2e` — Playwright e2e (auto-starts a dev server on port 4300). First-time setup: `npx playwright install chromium`. `npm run e2e:ui` for the runner UI.

## Deployment

Deployment is a **GitHub Actions pipeline** (`.github/workflows/deploy.yml`), not committed build output. On push to `master` it runs three jobs: `verify` (lint + Vitest + Playwright e2e), `build` (`ng build --base-href "/<repo>/"`, base href derived from the repo name so it isn't hard-coded, + a `404.html` copy of `dist/browser/index.html` as a fallback for genuinely unknown paths), and `deploy` (uploads the **`dist/browser`** artifact and publishes via `actions/deploy-pages`). Build output (`dist/`) is git-ignored and never committed.

One-time repo setting: **Settings → Pages → Build and deployment → Source = "GitHub Actions"**. The site publishes to `https://<owner>.github.io/<repo>/`. `npm ci` requires `package-lock.json` to be committed.

### Static prerendering (SSG) + SEO

The app is **prerendered to static HTML at build time** via `@angular/ssr` — there is **no server runtime** (`outputMode: "static"` in `angular.json`, `server: src/main.server.ts`, and `app.routes.server.ts` renders every route with `RenderMode.Prerender`). This is what makes deep links like `/tax` return a real **HTTP 200** with content (each route emits its own `dist/browser/<route>/index.html`) instead of routing through the 404 fallback, and it lets crawlers/unfurlers see real HTML. GitHub Pages hosting is unchanged — it just serves the files. Output moved from a flat `dist/` to **`dist/browser/`** (SSR layout); the deploy workflow and `e2e/static-server.mjs` point there. `provideClientHydration()` in `app.config.ts` takes the static DOM over on the client, so IndexedDB, the SW and all client state behave exactly as before after hydration.

**Browser-only APIs are platform-guarded** so the build-time render doesn't throw: `StorageService.bind()` short-circuits (keeps defaults, marks ready) when `!isPlatformBrowser`, and `PreferencesStore`'s theme `effect` skips its `document` write on the server. Export/transfer/QR/image code is user-action-only and never runs during prerender. The **dashboard is served at the root `''`** so the home page is real prerendered content at the canonical URL; `/dashboard` (and `/profile`, `**`) redirect to it.

**Per-page metadata** is resolved at prerender time by `core/seo/seo.service.ts` (bootstrapped from `App`): on each `NavigationEnd` it reads the deepest route's `data.seo` (`{ description, index }` in `app.routes.ts`) and sets `<title>` (route `title`), description, canonical, OG/Twitter, `robots` (`noindex,follow` for non-indexed routes), and a `WebApplication` JSON-LD block for indexed pages — all baked into the served HTML. **Scope:** only the root `/` (dashboard), `/tax`, `/loan` are indexed (real standalone content); the five data-entry pillars (income/spending/saving/insurance/investing) are prerendered but `noindex` + excluded from the sitemap.

**Crawlability:** `public/sitemap.xml` (the three indexed URLs) and `public/robots.txt` ship as static assets. ⚠️ Crawlers read `robots.txt` from the **host root** (`https://<owner>.github.io/robots.txt`), not the project subpath, so the subpath copy is advisory — the `noindex` meta tags are the authoritative signal for the private pillars. The host-authoritative copy (with the same `Disallow`s + a `Sitemap:` line pointing here) lives at the root of the separate `razeem.github.io` repo.

### PWA (installable + offline)

The app is a **Progressive Web App** via `@angular/service-worker`. `provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode() })` in `app.config.ts` registers the worker **only in production builds** (disabled under `ng serve`, so the Playwright dev server is unaffected). `ngsw-config.json` (referenced from `angular.json` `build > serviceWorker`) prefetches the app shell and lazily caches `public/**` + Google Fonts; `public/manifest.webmanifest` (linked from `index.html`, with Apple PWA metas) makes it installable. All manifest/SW paths are **relative** (`start_url`/`scope` = `.`) so they stay valid under the GitHub Pages subpath — `ngsw.json`'s `index` is emitted with the base-href prefix automatically. Icons: `favicon.svg` + `icon-192.png` + `icon-512.png` (the 512 doubles as the maskable icon). Offline needs no app code — data already lives in IndexedDB; the SW just caches the shell. The deploy workflow needs no changes (SW + manifest ship in `dist/browser/`).

## Architecture

A personal-finance dashboard organised as **7 pillars**. Feature-first, standalone components, no NgModules.

```
src/app/
  app.config.ts          providers: zoneless CD, async animations, router
  app.routes.ts          PILLARS (single source for nav + router) + lazy loadComponent routes + redirects
  app.ts / .html / .scss shell: toolbar (avatar menu + theme) + collapsible mat-sidenav + <router-outlet>
  core/
    finance/   finance.model.ts (types + pure deriveFinance), tax.model.ts (old/new regime, data-driven TaxConfig),
               emi.model.ts (pure EMI + amortization), prepayment.model.ts (pure debt-free forecast),
               inflation.model.ts (pure future-cost / present-value),
               nps.model.ts (pure NPS corpus → lumpsum + pension, incl. today's-money figures),
               history.model.ts (pure month snapshots, YYYY-MM keys, Indian-FY ranges + aggregation),
               finance-store.ts (THE shared model — one binding, derived signals),
               history-store.ts (month-by-month memory; auto rollover, flexible start),
               tax-config-store.ts (user-editable tax rulebook; FinanceStore reads it),
               assumptions-store.ts (user-editable inflation assumption; the calculators read it)
    profile/   profile.model.ts, profile-store.ts (shared: form + shell avatar)
    preferences/ preferences-store.ts (sidebar collapsed + theme)
    storage/   db.ts (idb schema + structural migrations), storage.service.ts (persistence API)
    export/    excel-export.service.ts (exceljs, dynamically imported; simple + composed sheets),
               finance-workbook.service.ts (whole-model .xlsx — the Dashboard "Export workbook")
    image/     image-compression.ts (canvas → WebP Blob)
  shared/ui/   stat-tile, section-card, pillar-card, coming-soon, line-item-list,
               inline-prompt, rating-input, page-header, slider-field (calculator input: chip + slider),
               spark-chart (dependency-free SVG line/bar chart; pure geometry in spark-chart.model.ts)
  features/
    dashboard/  income/  spending/  saving/  loan/  insurance/  investing/  tax/
    settings/ (profile-form + tax-rules-form + assumptions-form + settings-dialog)
    coming-soon-page/  (the placeholder for any `status: 'soon'` pillar — currently NONE; all 8 pillars are active)
```

- **Pillars**: `PILLARS` in `app.routes.ts` drives both the sidebar and routes. All 8 pillars are currently `status: 'active'` with their own feature component; a `status: 'soon'` pillar would route to `ComingSoonPage` instead (title/icon from route `data`), but none are soon right now. Old links redirect: `/income-tax → /tax`, `/profile → /dashboard` (profile now lives in the avatar → settings dialog).
- **Naming**: Angular 22 convention, no `.component` suffix (`income.ts`, class `Income`).
- **State**: signals + `computed()`; `inject()`; `OnPush` everywhere; typed reactive forms via `NonNullableFormBuilder`. Icons are **Material Symbols Rounded** (set as the default mat-icon font in `App`).
- **Styling**: Tailwind v4's entry lives in `src/tailwind.css` (`@import 'tailwindcss'`) — **kept separate from SCSS on purpose**, because Dart Sass cannot resolve that import; both files are in the `styles` array and processed by the builder's PostCSS pass (`.postcssrc.json` → `@tailwindcss/postcss`). Tailwind v4 needs no `tailwind.config.js` (content is auto-detected).
- **Tailwind-first for new markup (convention)**: when building or restyling any section, **always reach for Tailwind utility classes in the template first**. Layout and spacing — flex/grid, `gap`, padding/margin, alignment, `overflow`, sizing, simple typography — belong inline as utilities (`class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4 mb-5"`), **not** in a component `.scss`. Only fall back to SCSS for what utilities genuinely can't express cleanly: Material token overrides (`--mat-sys-*`, `::ng-deep`, `!important` on Material internals), CDK-applied classes (`.cdk-drag-*`), pseudo-elements/`::before`, gradient/`color-mix` backgrounds, and `var(--…)`-driven theming. A brand-new feature should ideally ship with **no `.scss` file at all** (see `spending/` — template-only). E2E selects by `data-testid`, never by CSS class, so utility classes are safe to change freely.
- **Theme (design language)**: ported from the owner's `razeem.github.io` bio site — **indigo→cyan gradient** (`--accent-1 #6366f1` → `--accent-2 #22d3ee`), a **deep-navy dark-first** canvas, Inter + **JetBrains Mono** for figures, an ambient `body::before` glow, and pill/gradient nav. `src/styles.scss` defines these **bio tokens** (`--bg`, `--bg-card`, `--text`, `--border`, `--nav-bg`, `--gradient`, radii, `--transition`) as light/dark sets, then **bridges** them onto Material's `--mat-sys-*` tokens (still generated by `mat.theme(...)` with violet+cyan palettes) so Material components inherit the palette. Light/dark is driven by `prefers-color-scheme` **and** an explicit `html[data-theme]` attribute that `PreferencesStore` sets (system mode removes it). Shell: a taller translucent blurred top bar (brand + theme toggle + settings gear), and a collapsible left sidebar with the user/profile pinned bottom (Drupal-nav style) + an icon-only chevron collapse toggle; the rail transition is a smooth Material ease. Brand/favicon/OG all use the ascending-bars logo in `public/favicon.svg`.
- **exceljs** is CommonJS and heavy (~950 kB); it is `await import()`-ed inside `ExcelExportService` so it only loads on first export and stays out of the initial bundle. It is allow-listed in `angular.json` (`allowedCommonJsDependencies`).
- **Global export**: `FinanceWorkbookService.export()` builds ONE workbook spanning every pillar (profile, income, spending, tax + active rulebook) from the shared model. It uses `ExcelExportService.exportComposed()` (stacks several small titled tables per worksheet) to keep it to two tabs — **Overview** and **Income & Spending** — splitting further only if a section gets unwieldy. The trigger is the **Dashboard → "Export workbook"** button (`data-testid="dashboard-export"`); the old profile-only export was removed from Settings. **Pass 1 writes plain computed values**; a later pass will emit live cross-sheet Excel formulas mirroring `deriveFinance`.

## Persistence pattern (how EVERY tool saves state)

IndexedDB (via `idb`) is the single persistence mechanism. Features never touch IndexedDB directly — they bind a signal-backed collection from `StorageService` (`core/storage/storage.service.ts`).

```ts
private readonly store = inject(StorageService).bind<MyState>({
  key: 'my-tool',        // unique document key
  version: 1,            // bump when the shape of MyState changes
  defaults: DEFAULTS,    // used pre-hydration and when nothing is stored
  migrate: (data, from) => upgrade(data), // optional; convert older documents
});

// read (signal) — starts at defaults, then hydrates from IndexedDB
this.store.value();      // Signal<MyState>
this.store.ready();      // Signal<boolean> — true once the initial load settled

// write — every mutation is mirrored to IndexedDB (debounced, write-through)
this.store.set(next);
this.store.patch({ field: value });
this.store.update((cur) => ({ ...cur, ... }));
await this.store.flush();  // force pending write (call before export/tests)
await this.store.reset();  // clear the stored document → defaults
```

Wiring conventions used by the tools:

- **Auto-load**: read `store.value()` in the template / a `computed()`. For reactive forms, seed the form **once** with an `effect` guarded on `store.ready()` that then `destroy()`s itself, patching with `{ emitEvent: false }` to avoid a write-back loop (see `features/settings/profile-form.ts`).
- **Auto-save**: for signal inputs, call `store.patch(...)` on change. For reactive forms, subscribe to `valueChanges` → `store.patch(value)` with `takeUntilDestroyed()`.
- **Blobs**: store `Blob`s directly in the state object (IndexedDB structured-clone handles them natively — no base64). The profile photo is compressed to WebP via `compressImage()` before being put in state.
- **Domain stores**: rather than binding raw collections in components, the app wraps them in singleton stores — `FinanceStore`, `ProfileStore`, `PreferencesStore` — that expose `computed` derived state + typed setters. Components inject the store; they never call `StorageService` directly.

### Two-level versioning / migrations

1. **Document-level** (common): each collection carries its `version`; on load, a mismatched stored document is passed to `migrate(data, fromVersion)`. Bump `version` + supply `migrate` when a tool's state shape changes. No DB reopen needed.
2. **Structural** (rare): the IndexedDB `DB_VERSION` in `core/storage/db.ts` governs object stores/indexes. Bump it and add an `if (oldVersion < N)` block in `upgrade()` only when you add/change a store — most changes are document-level and never touch this.

Every stored record is wrapped in a `StoredEnvelope` (`{ version, data, updatedAt }`) so the schema version always travels with the data.

## Shared financial model (the core idea)

`FinanceStore` (`core/finance/finance-store.ts`) is the **single shared state** for the whole app. Every value is entered **exactly once**, in the pillar that owns it; every other pillar reads derived numbers — nothing is re-typed.

- **Monthly by default**: income, spending, savings, insurance and investing are all entered **MONTHLY**. India tax is yearly, so `deriveFinance` annualises for the tax model and divides the annual tax back to a monthly figure — every budget number it returns (net, minimum, surplus, allocation) is monthly. `gross` is the _typical_ monthly base; **`annualGross`** is the actual sum of the **12-month salary breakdown** (`income.months`, Apr→Mar, each `{ base, bonus }`) — the tax basis. `setGross` **smart-fills** the breakdown (months still matching the old gross follow the new one; genuine overrides are kept).
- **Ownership**: **Loan** owns `loans[]` (see below); Income owns `gross`, `shortTermSavings`, the 12-month breakdown, goals, ideas; Spending owns `needs[]`/`wants[]`; **Insurance** owns `premiums[]` (per-item `period: monthly|yearly`, yearly ÷12); **Investing** owns `mandatory[]` (EPF/NPS, bucketed under Living) + `voluntary[]` (Growth & Freedom); **Loan** owns `emis[]`; **Saving** owns `emergencyMultiplier`; Tax owns `regime` + deductions. `LineItem` carries optional `period` and `mandatory`; `sumLineItemsMonthly` is period-aware. **Insurance, Loan and Investing all expose the per-row `/mo` `/yr` toggle** (`[allowPeriod]` on `app-line-item-list`) and `deriveFinance` sums all three period-aware — if you add the toggle anywhere new, make the matching total period-aware too, or the list footer will disagree with the pillar tile.
- **Derived** (`deriveFinance`, pure + unit-tested): `totalNeeds` (spending **+ loan EMIs**), `totalWants`, `annualGross`, `taxAnnual`, monthly `taxPayable`, `netIncome`, `minimumIncome`, `surplus`, and the **spend-allocation** buckets `allocation.{living,safety,growthFreedom,total}` (Living = needs+wants+mandatory investments; Safety = insurance+savings; Growth&Freedom = discretionary investments).
- **Spend allocation** (dashboard card): a draggable two-handle split bar sets the target ratio (default **75:15:10**, always sums 100 by construction — stored as `allocationTarget`), compared against actuals per bucket. `FinanceStore.setAllocationTarget`.
- **Circular dependency** (Gross → Tax → Minimum): resolved by making **Gross the only entered value**; Tax and Minimum Income are both derived. Never back-solve gross from minimum.
- **Minimum Income formula** is implemented literally (`Needs + Wants + Savings + Insurance + Investments − Tax`, monthly) in one place in `deriveFinance`. It is exposed twice: `minimumIncomeRaw` (the literal formula) and **`minimumIncome`, floored at 0**. Subtracting tax can drive the raw figure negative when outgoings are barely declared, and a negative minimum would make `surplus` exceed `netIncome`. `surplus` uses the clamped value; the Income breakdown shows the raw one when the floor bites, so its rows still add up.
- **Persistence/migrations**: the `finance` doc is at **version 5** (`FinanceStore.bind`) — v1→v2 seeded the 12-month breakdown, v2→v3 the allocation target, v3→v4 split `investing.contributions` into `mandatory`/`voluntary`, v4→v5 seeded the Saving pillar's emergency multiplier. Bump + extend `migrate` when the shape changes, and keep `KNOWN_COLLECTIONS` in `core/transfer/transfer.model.ts` in step (a stale version there makes exported documents look `newer-unsupported` and silently skips them on import).
- **Global export** lives in the **top bar** (`App.exportWorkbook`, `data-testid="dashboard-export"`), not the Dashboard body.
- **Inline prompts**: when a pillar needs a value another owns but it's still empty, render `app-inline-prompt` linking to the owning pillar instead of a duplicate input.

Tax math lives in `core/finance/tax.model.ts` — pure `calculateOldRegimeTax` / `calculateNewRegimeTax` / `calculateTax` (clamped progressive slabs, caps, cess, 87A rebate). The rules are **data, not constants**: every function takes a `TaxConfig` (defaulting to `DEFAULT_TAX_CONFIG`, which ships **FY 2025-26 / Budget 2025** slabs — new regime is tax-free up to ₹12L via an 87A rebate capped at ₹60k). Keep the functions pure — components and unit tests depend on it.

The config is **user-editable**: `TaxConfigStore` (`core/finance/tax-config-store.ts`, `providedIn:'root'`) binds a `tax-config` collection and exposes setters for slabs (add/remove/edit), standard deduction, rebate limit/amount, cess, and 80C/80D caps, plus `reset()` (restore shipped defaults). `FinanceStore.derived` reads `taxConfig.config()` so the **whole app recomputes** when rules change. The editor is the **"Tax rules" tab** in the Settings dialog (`features/settings/tax-rules-form.ts`). To update the shipped baseline for a new FY, edit `DEFAULT_TAX_CONFIG` in one place.

## Month history (the tracker + charts)

`FinanceStore` describes **one steady-state month**; `HistoryStore` (`core/finance/history-store.ts`, collection `finance-history` v1) remembers what the months **actually were**. The design decision: a month is a **snapshot of the shared model, not a transaction ledger** — the pillars already describe a month, so history freezes that description at rollover and trends fall out without anyone booking entries.

- **Shape**: one document, a **sparse map keyed `YYYY-MM`** (`{ months, trackingStart, startMode }`). Sparse + one document is what makes the flexible start (`first-use` | `fy` | `custom`) a _setting_ rather than a third data model. Keys sort correctly as plain strings — rely on that instead of parsing.
- **Rollover**: a self-destroying `effect` guarded on both stores' `ready()` (and `isPlatformBrowser` — prerender must not invent a snapshot) calls `ensureCurrentMonth()`. It freezes **only the single previous month** (the current one isn't over yet), and **never touches a `manual` or `backfill` snapshot**. `setStartMode` calls it too, so picking a start catches up immediately rather than waiting for the next load. Gaps are the user's to fill deliberately.
- **`MonthBreakdown` is a partition of `expenses`** — `snapshotFromDerived` pulls loan EMIs back out of `totalNeeds`, or the stacked chart and the total would double-count them. Short-term savings are deliberately _not_ an expense, so `income − expenses` is what the month put aside. `applyEdit` always re-derives `expenses` from the breakdown so the two cannot drift.
- **`scaleBreakdownTo`** backs the tracker's single "Spent" field: it corrects the _size_ of a month while keeping the _shape_ of its category split (everything lands in `needs` when there are no proportions to keep). Individual categories stay editable under "Split it out".
- **UI**: the **History tab** on Spending (`?tab=history`, query-param tab pattern). Months are pre-filled by carrying the previous one forward and chipped "Carried over" until edited; the first edit marks them `manual`.
- **Charts**: `shared/ui/spark-chart` — **no charting library**. All geometry is pure maths in `spark-chart.model.ts` (scales, `niceCeil` axis rounding, line paths, grouped/stacked bars), unit-tested without rendering; the component only emits SVG, like the EMI donut. It scales via `viewBox` (uniform — `preserveAspectRatio="none"` would stretch the text), so prerender and hydration agree. `aggregateByFy` rolls months into Indian financial years using the same Apr→Mar window as `fyKeyRange`; only recorded months are plotted, since a blank month would read as a real ₹0.

## Loans + the debt-free forecast

The Loan pillar owns **`loan.loans[]` of `Loan`** (`{ id, name, emi, period?, principal, annualRatePct, startDate, kind }`), not flat line items. `finance` is at **version 6**; v5→v6 **reshapes only** — old `type` → `name`, `value` → `emi`, `period` carried across untouched — so `deriveFinance` returns identical `totalNeeds` / `minimumIncome` / `emergencyTarget` before and after. `finance-store.spec.ts` pins exactly that; if it ever fails, the migration is lying.

- **`principal` is the outstanding balance today**, not the amount originally borrowed. That is what a debt-free forecast needs, and it means the projection works without knowing when the loan started (`startDate` is informational).
- **Only `name` + `emi` are required** — that is all the budget needs. The rest is what a forecast needs, so a loan is never hidden for being incomplete: **`loanGaps(loan)`** is the single source of "what is still missing" (`principal` | `rate` | `emi` | `billedYearly`), and both the Loan list and the Forecast tab render it as a prompt.
- **Yearly-billed loans keep their `period`.** `deriveFinance` stays period-aware (`sumLoansMonthly`), but the monthly amortization core has no representation for them, so `billedYearly` is reported as a gap and **`toMonthlyBilling()` converts only on an explicit user action** with the arithmetic shown. Nothing is ever silently rewritten.
- **`prepayment.model.ts`** is pure and knows nothing about `period` — the guard lives at the entrance to the Forecast tab, not inside the maths. `forecast(position, strategy, fromMonth)` runs reducing-balance from the outstanding balance under `baseline` | `stepUp {pct|amount}` | `lumpSum {amount, yearly|afterMonths}`; **prepayments shorten the tenure, never the instalment**. `neverPaysOff` flags an instalment that doesn't cover the interest instead of grinding to `MAX_MONTHS`. `compareStrategies` always measures against the baseline. Tied to `calculateEmi` by a known-answer test (₹30L @ 9% / 240mo reproduces its schedule month by month).
- **Forecast tab** (`?tab=forecast`) follows the calculator conventions and seeds its prepayment slider from the **mean surplus of the last three recorded months** (`HistoryStore`), with a "Use that" re-sync — the NPS-seed pattern.

## Calculators (Loan · Investing)

Alongside the declaration pillars there are three **scratchpad calculators**. They share one shape: pure model in `core/finance/`, sliders on the left via `app-slider-field`, headline figures on the right, a schedule/forecast table below. Their inputs are **local signals, deliberately not persisted** — a calculator is a scratchpad — with two exceptions that are shared state (below).

- **EMI calculator** (`features/loan/emi-calculator.ts`, `?tab=calculator`) → `emi.model.ts`.
- **Inflation Adjuster** (`features/investing/inflation-adjuster.ts`, `?tab=inflation`) → `inflation.model.ts`: pure `inflate` (future cost), `presentValue` (today's worth), `erosionPct`, and `projectInflation` which returns one row per year (`0…years`, inclusive) so the UI can index the **selected target year** out of a 40-year horizon and highlight it in the forecast table.
- **NPS calculator** (`features/investing/nps-calculator.ts`, `?tab=nps`) → `nps.model.ts`: monthly contribution compounded to retirement (contribution at the **start** of each month, annuity-due), then split into annuity corpus (≥ `MIN_ANNUITY_SHARE_PCT` = 40% by NPS rules) and lumpsum, with `monthlyPension = annuityCorpus × annuityRate ÷ 12`. Every headline figure also comes back in **today's money** under `result.real` (discounted via `inflation.model`) — that's the "₹68L at 60 ≈ ₹12L today" answer.

**The two automated fields** (nothing is typed twice):

1. **Inflation rate** is _not_ a scratch input — it's the app-wide assumption in `AssumptionsStore` (`core/finance/assumptions-store.ts`, `assumptions` collection v1, default **6%**, bounds in `INFLATION_RANGE`). Both calculators read _and write_ it, and it's editable in the **"Assumptions" tab** of the Settings dialog (`features/settings/assumptions-form.ts`); every real-terms figure recomputes live. Same idea as `TaxConfigStore`: shipped baseline + `reset()`.
2. **NPS monthly contribution** is seeded from the shared model — any Investing line item whose name matches `/\bnps\b/i` (mandatory or voluntary, period-aware via `sumLineItemsMonthly`). The seed runs once through a self-destroying `effect` guarded on `FinanceStore.ready()`; after that the slider is scratch, and a **"Use that"** button re-syncs.

Slider/donut styling is shared, not per-component: the `.app-slider` and `.app-donut-seg` utilities in `styles.scss` (global, so no `::ng-deep` needed).

**In-page tabs are deep-linkable**: Income (`?tab=minimum|goals|ideas`), Tax (`?tab=calculator|comparer`), Loan (`?tab=loans|forecast|calculator`), Spending (`?tab=budget|history`) and Investing (`?tab=contributions|inflation|nps`) sync a `?tab=` query param to the `mat-tab-group` `selectedIndex` (via `toSignal(route.queryParamMap)` + `router.navigate(..., { replaceUrl: true })`). A query param (not a fragment or child routes) keeps tab components mounted so local state — e.g. the ICER sort snapshot — survives tab switches. The **ICER table sorts on a one-shot snapshot** (`order` signal set on header click), never a live `computed`, so editing a rating never reorders rows mid-edit.

## Cross-device data transfer (export / import)

Because everything is local to one device, `core/transfer/` moves the whole model across devices. `transfer.model.ts` is **pure + unit-tested**: `encode` snapshots every stored collection (each still in its `StoredEnvelope`, so versions travel with the data) → `gzip(JSON)` (native `CompressionStream`, driven via writer/reader so it also runs under jsdom) → base64, behind a `PFD1:` marker; `decode` reverses it with typed `TransferError`s; `summarize` classifies each collection against `KNOWN_COLLECTIONS` (**keep those versions in sync with each store's `bind({ version })`**) as `ok` / `will-migrate` / `newer-unsupported` / `unknown`. **Blobs** (the profile photo) are walked into `{ __blob__, type }` sentinels and back — `encode({ includeBlobs: false })` drops them for the QR path.

`TransferService` (`providedIn: 'root'`) bridges it to storage via new `db.ts` helpers `dumpAllCollections()` / `writeCollections(map, { replace })`, then **reloads** so stores re-hydrate + run their migrators. **Merge = per-collection, incoming wins** (present collections overwrite, absent ones untouched); **Replace** clears the store first; `newer-unsupported` collections are always skipped. UI is the **"Transfer data"** tab in the Settings dialog (`features/settings/data-transfer.ts`), with copy/paste + QR. QR uses **`qrcode`** (generate) and **`jsqr`** (scan fallback behind native `BarcodeDetector`), both `await import()`-ed like exceljs and allow-listed in `angular.json`; the camera scanner is `features/settings/qr-scanner.ts`. QR omits the photo (too large for one code); copy/paste carries everything.

## Testing notes

- E2E relies on `data-testid` attributes on interactive elements — keep them stable; the Playwright specs (`e2e/`) select by them.
- Persistence e2e leans on Playwright's per-test context isolation (fresh IndexedDB per test); reloads within a test keep the same context. Debounced writes need a short settle (`waitForTimeout(~400ms)`) before a reload assertion.
