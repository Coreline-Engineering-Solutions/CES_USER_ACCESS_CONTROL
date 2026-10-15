/**
 * Where every call to the auth service goes. One place, so moving auth to another
 * address (the Durban cutover) is one edit per app, not a hunt through the code.
 * No trailing slash.
 */
export const AUTH_API_BASE = 'https://auth-api-frankfurt.onrender.com';
