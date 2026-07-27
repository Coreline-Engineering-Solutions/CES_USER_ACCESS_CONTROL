import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, map, take } from 'rxjs';
import { SessionService } from '../session/session.service';

/**
 * Gates a route on `SessionService.isValid()`. `App.ngOnInit` kicks off
 * `session.validate(null)` on bootstrap, but that call is async — a guard
 * that only reads `isValid()` synchronously races it and can wrongly bounce
 * a user who is actually logged in, just because the auth API hasn't
 * responded yet. This waits for `loading()` to flip false first.
 */
export const authGuard: CanActivateFn = () => {
  const sessionService = inject(SessionService);
  const router = inject(Router);

  if (!sessionService.loading()) {
    if (sessionService.isValid()) return true;
    router.navigate(['/signed-out']);
    return false;
  }

  return toObservable(sessionService.loading).pipe(
    filter((loading) => !loading),
    take(1),
    map(() => {
      if (sessionService.isValid()) return true;
      router.navigate(['/signed-out']);
      return false;
    })
  );
};
