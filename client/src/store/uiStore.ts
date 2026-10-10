import { create } from 'zustand';
import { useIsCoarsePointer, useLayoutMode } from '@/hooks/useMediaQuery';

export type DashboardLayout = 'list' | 'cards';

interface UiState {
  sidebarWidth: number;
  /** Floating overlay mode — auto-hides, slides in on hover. Mutex with collapsed. */
  sidebarFloating: boolean;
  /** Pinned-collapsed mode — 64 px icon-only column. Mutex with floating. */
  sidebarCollapsed: boolean;
  /** Off-canvas navigation drawer used below 1024 px.
   *  Forced by the layout mode, so it is NEVER persisted. */
  mobileNavOpen: boolean;
  addAgentModalOpen: boolean;
  dashboardLayout: DashboardLayout;

  setSidebarWidth: (width: number) => void;
  /** Toggle floating mode. Forces collapsed = false (mutex). */
  toggleSidebarFloating: () => void;
  /** Toggle collapsed mode. Forces floating = false (mutex). */
  toggleSidebarCollapsed: () => void;
  setMobileNavOpen: (open: boolean) => void;
  toggleMobileNav: () => void;
  openAddAgentModal: () => void;
  closeAddAgentModal: () => void;
  setDashboardLayout: (layout: DashboardLayout) => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 600;
const STORAGE_KEY_WIDTH       = 'ov-sidebar-width';
const STORAGE_KEY_FLOATING    = 'obliview:sidebarFloating';
const STORAGE_KEY_COLLAPSED   = 'obliview:groupPanelCollapsed';
const STORAGE_KEY_DASH_LAYOUT = 'ov-dashboard-layout';

function loadSavedDashLayout(): DashboardLayout {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DASH_LAYOUT);
    if (saved === 'cards' || saved === 'list') return saved;
  } catch { /* ignore */ }
  return 'cards';
}

function loadSavedWidth(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (saved) {
      const w = parseInt(saved, 10);
      if (!isNaN(w) && w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) return w;
    }
  } catch { /* ignore */ }
  return 280;
}

/**
 * Resolve the initial mutex pair. If localStorage somehow holds both flags as
 * "true" (legacy state, manual edit), prefer collapsed and clear floating —
 * that way the user gets a consistent rendering on first load and the bad
 * combination is wiped on the next toggle.
 */
function loadSavedSidebarMutex(): { collapsed: boolean; floating: boolean } {
  let collapsed = false;
  let floating = false;
  try {
    collapsed = localStorage.getItem(STORAGE_KEY_COLLAPSED) === 'true';
    floating  = localStorage.getItem(STORAGE_KEY_FLOATING)  === 'true';
  } catch { /* ignore */ }
  if (collapsed && floating) {
    floating = false;
    try { localStorage.setItem(STORAGE_KEY_FLOATING, 'false'); } catch { /* ignore */ }
  }
  return { collapsed, floating };
}

const initialMutex = loadSavedSidebarMutex();

function persistMutex(collapsed: boolean, floating: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSED, String(collapsed));
    localStorage.setItem(STORAGE_KEY_FLOATING,  String(floating));
  } catch { /* ignore */ }
}

export const useUiStore = create<UiState>((set) => ({
  sidebarWidth: loadSavedWidth(),
  sidebarFloating: initialMutex.floating,
  sidebarCollapsed: initialMutex.collapsed,
  mobileNavOpen: false,
  addAgentModalOpen: false,
  dashboardLayout: loadSavedDashLayout(),

  setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
  toggleMobileNav: () => set((s) => ({ mobileNavOpen: !s.mobileNavOpen })),
  openAddAgentModal: () => set({ addAgentModalOpen: true }),
  closeAddAgentModal: () => set({ addAgentModalOpen: false }),
  setDashboardLayout: (layout) => {
    try { localStorage.setItem(STORAGE_KEY_DASH_LAYOUT, layout); } catch { /* ignore */ }
    set({ dashboardLayout: layout });
  },

  // Mutex toggles — flipping one always clears the other so the AppLayout
  // never has to render an inconsistent (260-px overlay around 64-px column)
  // intermediate state.
  toggleSidebarFloating: () => set((s) => {
    const next = !s.sidebarFloating;
    persistMutex(false, next);
    return { sidebarFloating: next, sidebarCollapsed: false };
  }),
  toggleSidebarCollapsed: () => set((s) => {
    const next = !s.sidebarCollapsed;
    persistMutex(next, false);
    return { sidebarCollapsed: next, sidebarFloating: false };
  }),

  setSidebarWidth: (width) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    try { localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped)); } catch { /* ignore */ }
    set({ sidebarWidth: clamped });
  },
}));

// ── Effective sidebar presentation ────────────────────────────────────────

export type SidebarPresentation = 'drawer' | 'pinned' | 'collapsed' | 'floating';

export interface EffectiveSidebar {
  presentation: SidebarPresentation;
  /** Below 1024 px: the sidebar lives in an off-canvas Drawer (hamburger). */
  isDrawer: boolean;
  /** Auto-hide (hover strip) mode actually in use. */
  floating: boolean;
  /** 64 px icon rail actually in use. */
  collapsed: boolean;
  /** Mouse resize handles are offered. */
  resizable: boolean;
  /** The Float / Pin toggle is offered (it needs a hovering pointer). */
  canFloat: boolean;
}

/**
 * The sidebar mode the shell must render, derived from the persisted desktop
 * preferences AND the current device. Forced states (drawer below lg, no
 * floating / resizing on a touch screen) are computed here and never written
 * back to localStorage — the stored preferences must survive a visit from a
 * phone or a tablet untouched.
 */
export function useEffectiveSidebar(): EffectiveSidebar {
  const mode = useLayoutMode();
  const coarse = useIsCoarsePointer();
  const floatingPref = useUiStore((s) => s.sidebarFloating);
  const collapsedPref = useUiStore((s) => s.sidebarCollapsed);

  if (mode !== 'desktop') {
    return {
      presentation: 'drawer',
      isDrawer: true,
      floating: false,
      collapsed: false,
      resizable: false,
      canFloat: false,
    };
  }

  // Floating opens on mouse-enter of an 8 px edge strip: unusable (and in the
  // Android back-gesture zone) on a touch screen → fall back to pinned.
  const floating = floatingPref && !coarse;
  const collapsed = collapsedPref && !floating;
  return {
    presentation: floating ? 'floating' : collapsed ? 'collapsed' : 'pinned',
    isDrawer: false,
    floating,
    collapsed,
    resizable: !coarse && !collapsed,
    canFloat: !coarse,
  };
}
