/**
 * Build-time defaults.
 *
 * `DEFAULT_SERVER_URL` is the address of the deployed speech server, so a new installation starts with
 * the server already filled in. It is a public address, not a secret: the access key stays in the device
 * keystore and is never compiled into the app.
 *
 * Two sources, in order:
 *  1. `EXPO_PUBLIC_DEFAULT_SERVER_URL` at build time (the Android release workflow passes it);
 *  2. `BAKED_SERVER_URL` below, which the Cloudflare deploy workflow fills in and commits once a server
 *     exists. An empty value means the user enters the address in Settings on first launch.
 */

// Filled in by .github/workflows/deploy-cloudflare.yml. Do not put a secret here.
const BAKED_SERVER_URL = '';

export const DEFAULT_SERVER_URL: string = process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL?.trim() || BAKED_SERVER_URL;
