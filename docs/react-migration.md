# Moving to React

Trea is moving from vanilla JS + hand-rolled hash routing to React + TypeScript,
built with Vite. This is incremental: the business logic in `src/core/`,
`src/data/` and `src/features/` is framework-agnostic already and is not being
rewritten. Only the UI layer moves.

## What changed in this first pass

- **Build tooling**: `package.json`, `vite.config.ts`, `tsconfig.json`. Run `npm run dev`
  for a dev server, `npm run build` for a production build to `dist/`.
- **`tsconfig.json`** has `allowJs: true, checkJs: false`, on purpose: existing
  `.js` modules keep working, unmodified, from new `.ts`/`.tsx` files. New code
  is TypeScript; old code converts gradually, file by file, as it is touched.
- **The root `app.js` is gone.** Its routing state machine (sign-in, verify,
  onboard, org switching) is now `src/auth/useAuthRouter.ts`, a hook. The
  panels it drove are `src/auth/AuthGate.tsx`.
- **`index.html`** is now a Vite entry: a `<div id="root">` and
  `<script type="module" src="/src/main.tsx">`. All the markup that used to
  live there is JSX now.
- **The dashboard itself is not ported.** `src/legacy/LegacyShell.tsx` renders
  the same sidebar/header/view-root markup the old `index.html` had, with the
  same ids, and calls the existing `bootUi()` from `src/ui/app.js` exactly
  once. Every view in `src/ui/views/*.js`, every `data-action` handler, the
  command palette, and the keyboard shortcuts all work completely unchanged.

## What's next (in order)

1. Convert `src/core/*.js` to `.ts` (small, no React involved, mostly adding
   types to things like `state.js` and `fb.js`).
2. Pick one view - `overview.js` is the simplest - and rewrite it as a React
   component rendered inside `LegacyShell`'s `#view-root`, replacing its entry
   in `VIEWS` (`src/ui/app.js`) with a React mount.
3. Repeat per view until `src/ui/views/` is empty, then retire `bootUi()`,
   `applyView()` and the hash router in `src/ui/app.js` in favour of a proper
   router (React Router, or just the hook pattern already used for the gate).
4. Only then consider converting `src/features/*.js` to `.ts` - they are
   already framework-agnostic, so there's no urgency.

## Deliberately not done in this pass

- No UI framework change to the views (Tailwind classes are copied as-is).
- No change to Firestore rules, data model, or anything in `src/features/`.
- Tailwind is still loaded from the CDN (`cdn.tailwindcss.com`), which prints
  a "should not be used in production" console warning. Moving it to a
  PostCSS build is a separate, later task.
