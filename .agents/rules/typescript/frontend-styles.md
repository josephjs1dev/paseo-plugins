# Frontend Coding Styles

Apply when editing frontend TypeScript, components, routes, state, or styles.
Read [TypeScript Coding Styles](coding-styles.md) for general language rules,
file-size thresholds, module boundaries, and testing. Follow the project's
existing framework and conventions; this guide adds frontend-specific guidance.

## Folder layout

Use the framework's route conventions and preserve an established architecture.
For a growing React/TypeScript app without one, this is a starting layout, not
a requirement to create every folder:

```text
src/
  app/                         # Router, app providers, layouts, composition
  features/
    checkout/
      CheckoutPage.tsx          # Composes the checkout experience
      CheckoutForm.tsx          # Feature interaction and rendering
      CheckoutForm.module.css   # If the project uses CSS Modules
      CheckoutForm.test.tsx
      use-checkout.ts           # Stateful orchestration, only if needed
      checkout-api.ts           # Requests and response validation
      checkout-schema.ts        # Runtime schema and derived contract types
      calculate-total.ts        # Pure domain calculation
      calculate-total.test.ts
  shared/
    ui/                        # Domain-independent controls and primitives
    lib/                       # Focused cross-feature utilities and adapters
  styles/                      # Global tokens, reset, base styles
e2e/                           # User journeys across routes/features
```

Colocate component styles, stories, and fixtures with their owner, alongside
unit tests. Keep each feature's components, hooks, API access, and schemas together
instead of scattering them across application-wide technical-layer directories.

## Routes and component boundaries

- For long JSX, extract a meaningful UI section with a small prop contract.
  Moving markup into a helper that needs most of the parent's locals does not
  improve the boundary. Simplify state and ownership before adding prop plumbing.
- Let routes/pages compose features and perform framework-owned routing,
  loading, and metadata work. Keep substantial business rules in their owning
  feature. A route's private feature can live beside that route instead of in
  `features/`; choose one ownership location, not duplicate implementations.
- In Next.js, preserve special files such as `page.tsx` and `layout.tsx`. Route
  groups and private folders can organize colocated code. Keep server-only
  dependencies out of client imports and place client boundaries where
  interaction requires them; do not mark an entire app as client code by default.
- Keep feature components domain-aware. Shared UI should expose props, events,
  children, or slots instead of knowing checkout endpoints or application stores.
  Move a component into shared UI only when its contract is useful across features.

## Styling

- Reuse existing UI primitives and styling tokens. Colocate component-specific
  CSS; reserve global styles for deliberate application-wide rules. Follow the
  installed CSS Modules, Tailwind, or other styling approach rather than mixing
  systems incidentally. Prefer named variants to many layout booleans.

## Data and state

- Separate data transport and runtime validation from rendering when they become
  substantial. Use the framework loader or existing query library for caching,
  invalidation, and request lifecycle. Do not build a second fetching/cache layer
  inside every component or introduce a library solely to match this layout.
- Keep transient state near its UI owner. Lift shared state to the nearest common
  owner; use URL state for shareable navigation/filter state where appropriate.
  Introduce a global store only for state with a real cross-feature lifecycle.
  Avoid copying server cache data into another store without a specific need.
- In React, derive values from props/state during rendering rather than syncing
  duplicate state with effects. Use effects to synchronize external systems and
  clean them up; keep user-triggered actions in event handlers. Follow the Rules
  of Hooks. A custom hook should own a coherent behavior, not hide an entire page.
- Keep component definitions outside render functions, use stable domain keys
  for changing lists, and preserve immutable props/state. Introduce memoization
  for a demonstrated need and follow the project's compiler setup.

## Interaction and testing

- Build loading, empty, error, and success states as part of the feature. Preserve
  semantic HTML, accessible labels, keyboard behavior, and focus through wrappers.
  Test important user flows through rendered behavior, not component internals.

## Sources and applicability

These rules are a nestkit synthesis; the sample layout is a default, not a
framework requirement. References reviewed on 2026-09-27:

- [Angular's style guide](https://angular.dev/style-guide) supports grouping
  code by feature and colocating related files; its Angular-specific conventions
  are not imposed on other frontends.
- [Thinking in React](https://react.dev/learn/thinking-in-react) and
  [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)
  explain component responsibilities, state ownership, and derived state.
- [Next.js project structure](https://nextjs.org/docs/app/getting-started/project-structure)
  documents route conventions and alternative colocation strategies.
