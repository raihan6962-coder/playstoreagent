/** A 401 means the admin session is gone — send the browser back to /login. */
export function guardAuth(response: Response): void {
  if (response.status === 401 && typeof window !== "undefined") {
    // Absolute URL on purpose: a hard navigation that clears all client state.
    window.location.assign(new URL("/login", window.location.origin).toString());
  }
}
