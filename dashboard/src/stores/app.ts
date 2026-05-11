import { create } from "zustand";

type Theme = "dark" | "light";

interface AppStore {
  sidebarOpen: boolean;
  commandPaletteOpen: boolean;
  selectedAgentId: string | null;
  searchQuery: string;
  fastMode: boolean;
  theme: Theme;
  notificationPanelOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setSelectedAgentId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  toggleFastMode: () => void;
  setFastMode: (on: boolean) => void;
  toggleTheme: () => void;
  setNotificationPanelOpen: (open: boolean) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  sidebarOpen: true,
  commandPaletteOpen: false,
  selectedAgentId: null,
  searchQuery: "",
  fastMode: false,
  theme: (localStorage.getItem("astra_theme") as Theme) ?? "dark",
  notificationPanelOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  toggleFastMode: () => set((s) => ({ fastMode: !s.fastMode })),
  setFastMode: (on) => set({ fastMode: on }),
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      localStorage.setItem("astra_theme", next);
      document.documentElement.classList.toggle("dark", next === "dark");
      document.documentElement.classList.toggle("light", next === "light");
      return { theme: next };
    }),
  setNotificationPanelOpen: (open) => set({ notificationPanelOpen: open }),
}));
