import { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateManifest } from '../core/update/manifest';
import { checkForUpdate, installUpdate, updatesSupported } from '../platform/update/appUpdate';

export type UpdateState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'upToDate' }
  | { status: 'available'; manifest: UpdateManifest }
  | { status: 'downloading'; manifest: UpdateManifest }
  | { status: 'noApk'; manifest: UpdateManifest }
  | { status: 'failed'; manifest: UpdateManifest | null };

/** Re-check at most this often while the app stays open. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

export interface AppUpdate {
  state: UpdateState;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

/**
 * Keeps the update state for the whole app. It checks once when the app starts and then every few
 * hours. A check never interrupts the user: it only changes what the screens show.
 */
export function useAppUpdate(): AppUpdate {
  const [state, setStateValue] = useState<UpdateState>(() =>
    updatesSupported() ? { status: 'idle' } : { status: 'unsupported' },
  );
  const current = useRef<UpdateState>(state);
  const busy = useRef(false);

  const setState = useCallback((next: UpdateState) => {
    current.current = next;
    setStateValue(next);
  }, []);

  const check = useCallback(async () => {
    if (!updatesSupported() || busy.current) {
      return;
    }
    busy.current = true;
    setState({ status: 'checking' });
    try {
      const manifest = await checkForUpdate();
      setState(manifest ? { status: 'available', manifest } : { status: 'upToDate' });
    } catch {
      setState({ status: 'failed', manifest: null });
    } finally {
      busy.current = false;
    }
  }, [setState]);

  const install = useCallback(async () => {
    const pending = current.current;
    const manifest =
      pending.status === 'available' || pending.status === 'failed' || pending.status === 'noApk'
        ? pending.manifest
        : null;
    if (!manifest || busy.current) {
      return;
    }
    busy.current = true;
    setState({ status: 'downloading', manifest });
    try {
      await installUpdate(manifest);
      setState({ status: 'available', manifest });
    } catch (error) {
      const noApk = error instanceof Error && error.message === 'no-apk';
      setState(noApk ? { status: 'noApk', manifest } : { status: 'failed', manifest });
    } finally {
      busy.current = false;
    }
  }, [setState]);

  useEffect(() => {
    if (!updatesSupported()) {
      return undefined;
    }
    // Scheduled so the first check starts after the first render, not inside the effect itself.
    const first = setTimeout(() => void check(), 0);
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [check]);

  return { state, check, install };
}
