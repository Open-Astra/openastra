import { create } from "zustand";
import { api, ApiError } from "@/lib/api";

export interface AuthUser {
  email: string;
  displayName?: string;
}

interface AuthStore {
  token: string | null;
  user: AuthUser | null;
  isAuthenticated: boolean;
  isInitializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  init: () => Promise<void>;
  /** Local development only — a no-op in production builds. */
  devLogin: () => void;
}

const TOKEN_KEY = "astra_token";
const USER_KEY = "astra_user";
const DEV_TOKEN_PREFIX = "dev-";

function loadPersisted(): { token: string | null; user: AuthUser | null } {
  const token = localStorage.getItem(TOKEN_KEY);
  const userStr = localStorage.getItem(USER_KEY);
  let user: AuthUser | null = null;
  if (userStr) {
    try {
      user = JSON.parse(userStr);
    } catch {
      user = null;
    }
  }
  return { token, user };
}

function clearPersisted(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** True when `token` is a structurally valid, unexpired JWT. */
function isUnexpiredJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(
      atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/** Mock tokens are only ever honoured by the Vite dev server build. */
function isDevToken(token: string | null): boolean {
  return import.meta.env.DEV && Boolean(token?.startsWith(DEV_TOKEN_PREFIX));
}

export const useAuthStore = create<AuthStore>((set) => {
  const { token, user } = loadPersisted();

  return {
    token,
    user,
    // Never assume a persisted token is good — init() verifies it first.
    isAuthenticated: false,
    isInitializing: true,

    // Throws on failure (bad credentials, gateway unreachable, …). There is
    // deliberately no fallback: a failed login must never produce a session.
    login: async (email, password) => {
      const res = await api.auth.login({ email, password });
      const newUser: AuthUser = {
        email: res.user?.email ?? email,
        displayName: res.user?.displayName ?? undefined,
      };
      localStorage.setItem(TOKEN_KEY, res.accessToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      set({ token: res.accessToken, user: newUser, isAuthenticated: true });
    },

    devLogin: () => {
      if (!import.meta.env.DEV) return;
      const mockToken = `${DEV_TOKEN_PREFIX}${Date.now()}`;
      const newUser: AuthUser = { email: "dev@openastra.local", displayName: "dev" };
      localStorage.setItem(TOKEN_KEY, mockToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      set({ token: mockToken, user: newUser, isAuthenticated: true });
    },

    logout: () => {
      clearPersisted();
      set({ token: null, user: null, isAuthenticated: false });
    },

    init: async () => {
      const { token: stored, user: storedUser } = loadPersisted();
      if (!stored) {
        set({ token: null, user: null, isAuthenticated: false, isInitializing: false });
        return;
      }

      if (isDevToken(stored)) {
        set({ token: stored, user: storedUser, isAuthenticated: true, isInitializing: false });
        return;
      }

      // Malformed, expired, or leftover mock tokens are discarded outright.
      if (!isUnexpiredJwt(stored)) {
        clearPersisted();
        set({ token: null, user: null, isAuthenticated: false, isInitializing: false });
        return;
      }

      try {
        await api.auth.checkSession();
        set({ token: stored, user: storedUser, isAuthenticated: true, isInitializing: false });
      } catch (err) {
        // Verification failed — do NOT trust the persisted token. A definite
        // rejection clears it; if the gateway was merely unreachable the token
        // is kept on disk so a later reload can re-verify, but the user is
        // not treated as signed in.
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          clearPersisted();
          set({ token: null, user: null });
        }
        set({ isAuthenticated: false, isInitializing: false });
      }
    },
  };
});
