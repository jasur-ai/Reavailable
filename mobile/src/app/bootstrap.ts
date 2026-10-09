import { createAppServices, type AppServices } from './services';

let instance: Promise<AppServices> | null = null;

/**
 * Creates the services once per app process. React Strict Mode runs effects twice in development,
 * so the composition must not run twice: two libraries writing one file would race.
 */
export function getServices(): Promise<AppServices> {
  if (!instance) {
    instance = createAppServices().then(async (services) => {
      await services.start();
      return services;
    });
    // A failed start can be retried from the UI.
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}
