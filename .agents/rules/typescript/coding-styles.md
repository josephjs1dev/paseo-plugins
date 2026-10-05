# TypeScript Coding Styles

Apply when editing TypeScript (`*.ts`, `*.tsx`, `*.mts`, `*.cts`) or its compiler
and lint configuration. Follow the project's explicit instructions and existing
tool configuration first. Use the defaults below where the project has no
convention; do not restyle unrelated code or migrate tooling during a feature fix.

For frontend work, also read [Frontend Coding Styles](frontend-styles.md).
Backend-only work does not need that companion guide.

## Compiler and runtime

- Enable `strict: true`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, and `noImplicitOverride` for new projects. The
  latter three are separate from `strict`. Adopt them deliberately in existing
  projects; do not weaken checks to make a change pass.
- Treat an indexed lookup as potentially missing. Distinguish an omitted
  optional property from one explicitly set to `undefined`.
- Choose `target`, `lib`, `module`, and `moduleResolution` for the actual runtime
  and build pipeline. Use compatible Node modes for code executed directly in
  Node and bundler resolution for bundled code. Do not copy a universal tsconfig.
- Keep browser and server dependencies separate. TypeScript `paths` mappings
  do not rewrite emitted imports; the runtime or bundler must resolve them too.
- Use the repository's type-check command. Transpilation alone does not prove
  type correctness; `tsc --noEmit` is suitable where the project supports it.

## Formatting and linting

- Use one formatter: the project's Prettier or Biome configuration. If no style
  exists, use two spaces, semicolons, single-quoted TypeScript strings,
  double-quoted JSX attributes, trailing commas, and an 80-column print width.
  These are nestkit defaults, not TypeScript correctness requirements.
- Let the formatter handle wrapping and whitespace. Use braces for conditional
  and loop bodies; avoid nested ternaries and long expression chains.
- For ESLint projects, start with typescript-eslint's `recommendedTypeChecked`
  preset and configure typed linting. Consider `strictTypeChecked` when the team
  wants its additional opinionated checks; do not enable every rule blindly.
- Enforce promise handling, unsafe `any` usage, and exhaustive union handling
  through applicable lint rules. Keep formatting rules from competing with the
  formatter. Reuse an existing Biome setup rather than replacing it incidentally.
- Scope any suppression to the smallest expression or line and explain why.
  Prefer `@ts-expect-error` with a reason for an intentional type error, including
  negative type tests; avoid `@ts-ignore` and file-wide checking disablement.

## Naming and documentation

- Use `camelCase` for variables, parameters, functions, methods, and properties;
  use `PascalCase` for types, interfaces, classes, and JSX components.
- Reserve `UPPER_SNAKE_CASE` for shared fixed constants, not every `const` binding.
  Name booleans as predicates (`isReady`, `hasAccess`) and functions by their work.
- Use descriptive domain names; avoid interface prefixes such as `IUser` unless
  established locally. Follow existing filename conventions and framework rules.
- Document public contracts and surprising behavior with JSDoc: units,
  invariants, side effects, errors, and cancellation. Explain decisions rather
  than repeating the type signature or narrating obvious code.

## Types and data modeling

- Infer obvious local types. Annotate public function parameters and return
  contracts where inference would obscure or accidentally widen the API.
- Use `unknown` for data whose shape has not been established; narrow before
  access. Avoid `any`, non-null assertions (`!`), and double casts such as
  `as unknown as T`. Isolate unavoidable interoperability escapes and explain
  the invariant that makes them safe.
- Use primitive types (`string`, `number`, `boolean`), not boxed wrapper types.
  Define domain records instead of using `object` or `{}` as a data contract.
- Use `type` for unions and aliases; use `interface` for object contracts that
  need extension or declaration merging. Either works for ordinary records;
  follow local practice rather than converting between them for style alone.
- Model mutually exclusive states with a discriminated union, rather than
  several booleans and optional fields. Handle every case and use `never` to
  expose missing branches when the union grows.
- Prefer string literal unions or `as const` objects for new closed sets when
  enum runtime behavior is unnecessary. Preserve enums required by existing APIs.
- Use `satisfies` to check an object's contract while retaining useful inferred
  detail. It does not validate runtime input. Use `as const` when literal
  inference and readonly properties are intended.
- Prefer `readonly` properties and readonly array parameters when mutation is
  not part of the contract. They express compile-time intent, not deep runtime
  immutability. Keep generics simple and use them to express real relationships.

```typescript
type LoadState<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'failed'; error: Error };

function describeState<T>(state: LoadState<T>): string {
  switch (state.status) {
    case 'loading':
      return 'Loading';
    case 'ready':
      return 'Ready';
    case 'failed':
      return state.error.message;
    default: {
      const unreachable: never = state;
      throw new Error('Unexpected load state', { cause: unreachable });
    }
  }
}
```

The example's error `cause` requires a compatible runtime and library target
(ES2022 or later). Adapt to the project's supported runtime.

## Runtime validation and null handling

- Treat network responses, parsed JSON, environment variables, storage reads,
  and model/tool output as untrusted. Parse them with the project's runtime
  schema library (for example, Zod or Valibot) or a complete validation function.
  A type assertion such as `payload as User` performs no validation.
- Derive types from schemas when supported, so runtime checks and static types
  stay aligned. Validate once at the trust boundary and pass typed data inward.
- Narrow nullable values explicitly. Use `??` when only `null` or `undefined`
  should trigger a fallback; `||` also replaces `0`, `false`, and empty strings.
- Use optional chaining for genuinely optional data, not to hide a broken
  invariant. Distinguish absent values from valid empty values in API contracts.
- Keep validation separate from authorization; a well-formed tool argument or
  request still needs the permission checks in the shared security rules.

## Functions, modules, and state

- Default to `const`; use `let` for reassignment and avoid `var`. Keep mutations
  local and explicit; do not mutate caller-owned inputs without a stated contract.
- Keep functions focused. Prefer early returns and simple loops when they make
  control flow clearer. Use an options object instead of several positional flags.
- Prefer named exports; retain default exports required by frameworks or an
  established public API. Export only what consumers need.
- Use `import type` for imports used only as types. Follow the project's module
  system, import extensions, aliases, and ordering. Preserve side-effect import
  order; avoid barrel files that introduce cycles or hide large dependency trees.
- Prefer composition and plain functions for stateless operations. Use classes
  when they clarify state ownership or lifecycle. Keep provider, tool, and
  persistence interfaces small and inject dependencies at external boundaries.

## File size and extraction

These are nestkit review thresholds for hand-written source, not language limits
or universal industry standards. Count nonblank, noncomment lines, including JSX.

| Unit | Default guidance |
| --- | --- |
| Source module or component file | Aim for roughly 100–250 lines when the responsibility warrants it; smaller is fine. Review for extraction above 300. |
| File above 500 lines | Split by responsibility, or explain in the change description why keeping it together is clearer. |
| Function or custom hook | Review above roughly 50 lines of logic, or earlier when branching, effects, or responsibilities multiply. |
| Generated code, declarations, fixtures, large tables, tests | Use separate judgment; keep related cases together and do not hand-edit generated output to satisfy a limit. |

- Keep one main concept per file. Its private types, constants, helpers, and
  small tightly related components may stay alongside it. Do not create one
  file per symbol or move code merely to get below a line count.
- Split when sections change for different reasons, have independent consumers,
  need different dependencies, or can be tested meaningfully on their own.
- Extract a named responsibility: `parseInvoice`, `InvoiceTotals`, or
  `useInvoiceSearch`. Avoid `helpers2.ts`, `misc.ts`, and giant `utils.ts` files.
- Keep a helper local while only one module needs it. Promote it when reuse or
  a clear domain boundary warrants a separate API, not in anticipation of reuse.

## Folder organization

- Group application code by feature or domain: `checkout`, `account`, `search`.
  Keep each feature's implementation, data access, validation, and tests close
  together. Avoid scattering every feature across global technical-layer
  directories such as `services/`, `repositories/`, and `types/`.
- Start a small feature with a flat folder. Add subfolders when they represent
  a distinct subfeature or a group that has become hard to navigate. Do not
  scaffold empty layers or a directory for every single file.
- Colocate unit tests and fixtures with their owner unless the framework or
  repository has an established alternative. Keep application-wide integration
  and end-to-end tests in their established location.
- Keep private types beside their implementation. Put a feature-wide schema or
  contract in a clearly named feature file; reserve shared contracts for actual
  cross-feature use. Avoid a repository-wide `types.ts` dumping ground.
- Make dependencies flow from application composition to features to shared
  foundations. Shared code must not import features or route modules. Coordinate
  features at the application layer; if a direct dependency is necessary, use
  an explicit public contract and keep the dependency graph acyclic.
- Import another feature through its supported entry point, not private files.
  An explicit `index.ts` can define that API when useful; do not add recursive
  re-export barrels to every directory. Inside a feature, import owners directly.

## Async work, errors, and resources

- Await or return promises. For intentional background work, attach a rejection
  handler and define its lifecycle; `void task()` alone does not handle failure.
- Avoid `forEach(async ...)`. Use `for...of` for sequential work, or collect and
  await promises for independent work. Bound concurrency for large collections.
- Use `Promise.all` when all results are required; use `Promise.allSettled` when
  partial outcomes matter and inspect every result. Rejection of `Promise.all`
  does not cancel the other operations.
- Propagate `AbortSignal` through cancellable I/O. Set timeouts, response-size
  limits, and bounded retries. Retry only appropriate transient failures and
  account for idempotency before retrying writes or tool actions.
- Throw `Error` objects or typed subclasses. Narrow caught values before access;
  JavaScript can throw anything. Preserve the original cause when adding context.
- Catch where code can recover, translate, or add useful context. Do not swallow
  errors or log and rethrow at every layer. Use discriminated results for expected
  failures when that matches the existing API.
- Release listeners, timers, streams, and other resources through `finally` or
  the project's disposal mechanism. Keep cancellation distinct from failure.
- Keep logs structured and redact sensitive data. Never expose raw provider
  errors or internal stack traces directly to end users.

## Tests and delivery

- Use the existing test runner and package manager. Commit the appropriate
  lockfile; avoid adding a second lockfile or a dependency for a trivial helper.
- Test observable behavior and boundary cases: missing values, invalid input,
  authorization, rejection, retries, cancellation, and malformed model responses.
  Mock network, persistence, and time boundaries rather than private internals.
- Await asynchronous tests and assert rejection paths. Use typed fixtures or
  `satisfies` instead of casting incomplete mocks through `any`.
- Run the relevant formatter check, lint, type check, and targeted tests using
  repository scripts. Include a build when module or packaging changes require
  it. Report checks that could not run; do not claim transpilation as type checking.

## Sources and applicability

These rules are a nestkit synthesis. Public projects differ on indentation,
exports, and tooling; their repository-specific choices are not universal rules.
References reviewed on 2026-09-27:

- [VS Code's public Copilot instructions](https://github.com/microsoft/vscode/blob/main/.github/copilot-instructions.md)
  provide a real example of model-facing coding, architecture, and validation
  guidance. VS Code uses tabs and its own service APIs; those details stay local.
- [Google's TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
  covers naming, modules, types, and documentation, with Google-specific caveats.
- [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/) and
  [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html)
  explain strictness, optional properties, and runtime-dependent module behavior.
- [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
  and [the `satisfies` operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html)
  support the type-modeling guidance.
- [typescript-eslint shared configurations](https://typescript-eslint.io/users/configs/)
  and [promise handling](https://typescript-eslint.io/rules/no-floating-promises/)
  explain typed linting and why `void` is insufficient for rejection handling.
- [Angular's style guide](https://angular.dev/style-guide) supports feature-based
  grouping, colocation, and one concept per file; its framework-specific naming
  and dependency-injection rules are not imposed on other frontends.
