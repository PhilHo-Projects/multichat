import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Served from the same origin as the app, so no baseURL is needed.
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
