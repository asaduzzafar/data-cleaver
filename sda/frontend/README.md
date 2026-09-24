# Data Cleaver — frontend

React 19 + TypeScript + Tailwind v4, built with Vite.

```
npm install
npm run dev        # Vite on :5173, proxying /api to the backend on :8000
npm run build      # type-check and build into dist/ (served by the backend)
```

## Tests

```
npm test           # component tests (Vitest + Testing Library, jsdom)
npm run test:a11y  # WCAG 2.1 AA with axe, in a real browser
```

**Component tests** (`tests/unit`) render screens against a stubbed API and
assert content and roles, never styling, so they survive visual changes.

**Accessibility tests** (`tests/a11y`) build the UI, start the real app on a
throwaway app-data folder with a small sample dataset, and run axe on each
view in your installed Chrome — no browser download. jsdom cannot compute
colour contrast, which is why this runs in a real browser.

They work as a ratchet against `tests/a11y/baseline.json`: a view fails if it
breaks a rule it did not break before, or breaks one on more elements. After
fixing violations, shrink the baseline:

```
UPDATE_A11Y_BASELINE=1 npm run test:a11y
```

Never raise a baseline count to make a test pass. Fix the view instead.
