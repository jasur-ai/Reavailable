import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AppServices, Store } from './services';

const ServicesContext = createContext<AppServices | null>(null);

export const ServicesProvider = ServicesContext.Provider;

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error('useServices must be used inside ServicesProvider');
  }
  return services;
}

/** Subscribes a component to an external store. Re-renders when the store changes. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
