# CES User Access Control

Angular 21 app for Coreline Engineering Solutions, scaffolded from the same
session/auth pattern used by CES_NG_GIS and CES_MODULES:

- Auth is external — real login happens on `corelineengineering.com`, which
  sets `session_gid`/`user_email` cookies on the shared parent domain. This
  app only reads those cookies and validates them against the shared Auth API
  (`src/classes/ClassesAuth.ts`, `src/app/session/session.service.ts`).
- `authGuard` (`src/app/guards/auth.guard.ts`) actually gates routes here
  (waits for `SessionService.loading()` to resolve before checking
  `isValid()`, then bounces to `/signed-out`) — no in-app login page exists.
- For local dev without a real login flow, drop a
  `public/assets/local-session.dev.json` (`{ "email": "...", "session_gid": "..." }`)
  — gitignored, only read on localhost, see `src/app/session/local-session.ts`.
- `src/environments/environment.prod.ts` has a placeholder `apiBaseUrl` —
  update it once this app's own backend is deployed on Render.

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.19.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
