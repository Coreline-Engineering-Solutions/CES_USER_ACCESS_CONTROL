import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { hydrateLocalSession } from './app/session/local-session';

void hydrateLocalSession().finally(() => {
  bootstrapApplication(App, appConfig).catch((err: Error) => console.error(err));
});
