/**
 * Build-time defaults.
 *
 * `DEFAULT_SERVER_URL` is the address of the deployed speech server. A release build fills it in so
 * a new installation only needs the access key; an empty value means the user must enter both.
 * It is a public address, not a secret: the access key stays in the platform keystore.
 */

export const DEFAULT_SERVER_URL: string = process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL?.trim() || '';
