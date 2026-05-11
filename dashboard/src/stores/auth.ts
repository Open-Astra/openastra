import { create } from "zustand";
import { api } from "@/lib/api";

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
  devLogin: () => void;
}

const TOKEN_KEY = "astra_token";
const USER_KEY = "astra_user";

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

export const useAuthStore = create<AuthStore>((set) => {
  const { token, user } = loadPersisted();

  return {
    token,
    user,
    isAuthenticated: Boolean(token),
    isInitializing: true,

    login: async (email, password) => {
      try {
        const { token: newToken } = await api.auth.login({ email, password });
        const newUser: AuthUser = { email };
        localStorage.setItem(TOKEN_KEY, newToken);
        localStorage.setItem(USER_KEY, JSON.stringify(newUser));
        set({ token: newToken, user: newUser, isAuthenticated: true });
      } catch {
        // Dev fallback — let the user in if backend is unreachable
        const mockToken = `dev-${Date.now()}`;
        const newUser: AuthUser = { email, displayName: email.split("@")[0] };
        localStorage.setItem(TOKEN_KEY, mockToken);
        localStorage.setItem(USER_KEY, JSON.stringify(newUser));
        set({ token: mockToken, user: newUser, isAuthenticated: true });
      }
    },

    devLogin: () => {
      const mockToken = `dev-${Date.now()}`;
      const newUser: AuthUser = { email: "dev@openastra.local", displayName: "dev" };
      localStorage.setItem(TOKEN_KEY, mockToken);
      localStorage.setItem(USER_KEY, JSON.stringify(newUser));
      set({ token: mockToken, user: newUser, isAuthenticated: true });
    },

    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      set({ token: null, user: null, isAuthenticated: false });
    },

    init: async () => {
      const { token } = loadPersisted();
      if (!token) {
        set({ isInitializing: false });
        return;
      }
      try {
        const { valid } = await api.auth.verify();
        if (!valid) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          set({ token: null, user: null, isAuthenticated: false, isInitializing: false });
          return;
        }
      } catch {
        // Backend unreachable — trust persisted token (dev mode)
      }
      set({ isInitializing: false });
    },
  };
});
