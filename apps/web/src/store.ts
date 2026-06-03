import { create } from "zustand";
import type { EventEnvelope } from "../../../packages/shared/src/index.ts";

export type LiveStatus = "connecting" | "ready" | "error";

interface WorkbenchUiState {
  selectedProjectId: string | null;
  commandPaletteOpen: boolean;
  liveStatus: LiveStatus;
  liveTick: number;
  liveEvents: EventEnvelope[];
  setSelectedProjectId(projectId: string | null): void;
  openCommandPalette(): void;
  closeCommandPalette(): void;
  toggleCommandPalette(): void;
  pushEvent(event: EventEnvelope): void;
  setLiveStatus(status: LiveStatus): void;
}

export const useWorkbenchStore = create<WorkbenchUiState>((set) => ({
  selectedProjectId: null,
  commandPaletteOpen: false,
  liveStatus: "connecting",
  liveTick: 0,
  liveEvents: [],
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),
  pushEvent: (event) =>
    set((state) => ({
      liveTick: state.liveTick + 1,
      liveStatus: "ready",
      liveEvents: [event, ...state.liveEvents].slice(0, 100),
    })),
  setLiveStatus: (liveStatus) => set({ liveStatus }),
}));
