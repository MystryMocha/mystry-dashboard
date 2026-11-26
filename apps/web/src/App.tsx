import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FolderDown, Globe, LayoutGrid, LogOut, Menu, MonitorSmartphone, PanelLeftClose, PanelLeftOpen, Rocket, Server, Settings, Terminal, X } from 'lucide-react';
import { useAuth } from './auth';
import { useI18n, type MessageKey } from './i18n';
import { BrandMark } from './components/BrandMark';
import { LanguageToggle } from './components/LanguageToggle';
import { TaskCenter } from './components/TaskCenter';
import { ThemeToggle } from './components/ThemeToggle';
import { useDocumentTitle } from './hooks/useDocumentTitle';
import { ToolbarTitleContext } from './hooks/useToolbarTitle';
import { useRouteFocus } from './hooks/useRouteFocus';
import { LoginPage } from './pages/LoginPage';

// The dialog, together with the QR code library, is loaded only when opened and stays out of the initial bundle.
const RemoteAccessDialog = lazy(() =>
  import('./components/RemoteAccessDialog').then(({ RemoteAccessDialog }) => ({ default: RemoteAccessDialog })),
);
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then(({ DashboardPage }) => ({ default: DashboardPage })),
);
const InstancePage = lazy(() =>
  import('./pages/InstancePage').then(({ InstancePage }) => ({ default: InstancePage })),
);
const DeployPage = lazy(() =>
  import('./pages/DeployPage').then(({ DeployPage }) => ({ default: DeployPage })),
);
const ImportPage = lazy(() =>
  import('./pages/ImportPage').then(({ ImportPage }) => ({ default: ImportPage })),
);
const NodesPage = lazy(() =>
  import('./pages/NodesPage').then(({ NodesPage }) => ({ default: NodesPage })),
);
const MultiplayerPage = lazy(() =>
  import('./pages/MultiplayerPage').then(({ MultiplayerPage }) => ({ default: MultiplayerPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })),
);

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** Once the content area scrolls past this distance, the toolbar shows the page title and the frosted-glass background. */
const SCROLLED_THRESHOLD = 12;

const SIDEBAR_COLLAPSED_KEY = 'mystry_sidebar_collapsed';

// Read synchronously in useState so a saved collapsed rail renders collapsed immediately without a shrink flash on reload.
function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function pageTitleKeyFor(pathname: string): MessageKey {
  if (pathname === '/') return 'nav.overview';
  if (pathname.startsWith('/instances')) return 'shell.pageTitle.workspace';
  if (pathname.startsWith('/deploy')) return 'nav.deploy';
  if (pathname.startsWith('/import')) return 'nav.import';
  if (pathname.startsWith('/nodes')) return 'nav.machine';
  if (pathname.startsWith('/multiplayer')) return 'nav.multiplayer';
  if (pathname.startsWith('/settings')) return 'nav.settings';
  return 'shell.pageTitle.fallback';
}

function trimTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/** Page name in the browser tab title; the instance page includes the instance name and is set by InstancePage itself, so undefined is returned here. */
function documentTitleKeyFor(pathname: string, needsSetup: boolean): MessageKey | null | undefined {
  pathname = trimTrailingSlash(pathname);
  if (pathname === '/login') return needsSetup ? 'login.setup.title' : 'login.signin.title';
  if (pathname === '/') return 'nav.overview';
  if (/^\/instances\/[^/]+/.test(pathname)) return undefined;
  if (pathname === '/deploy') return 'nav.deploy';
  if (pathname === '/import') return 'nav.import';
  if (pathname === '/nodes') return 'nav.machine';
  if (pathname === '/multiplayer') return 'nav.multiplayer';
  if (pathname === '/settings') return 'nav.settings';
  return null;
}

/** Key used to decide "whether the page changed": switching tabs within the same instance is not a page change. */
function pageKeyFor(pathname: string): string {
  return /^\/instances\/[^/]+/.exec(pathname)?.[0] ?? trimTrailingSlash(pathname);
}

function DocumentTitle({ page }: { page: string | null }) {
  useDocumentTitle(page);
  return null;
}

/** Route-level accessibility: sets the browser tab title per route, and moves focus to the new page's main heading after a page change. */
function RouteAnnouncer() {
  const { t } = useI18n();
  const { needsSetup } = useAuth();
  const { pathname } = useLocation();
  useRouteFocus(pageKeyFor(pathname));
  const titleKey = documentTitleKeyFor(pathname, needsSetup);
  if (titleKey === undefined) return null;
  return <DocumentTitle page={titleKey ? t(titleKey) : null} />;
}

const navClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;
const tabClass = ({ isActive }: { isActive: boolean }) => `tab-bar-item${isActive ? ' active' : ''}`;

function PageLoading() {
  const { t } = useI18n();
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {t('shell.loading.page')}
    </div>
  );
}

function Splash() {
  const { t } = useI18n();
  return (
    <div className="splash" role="status" aria-live="polite">
      <BrandMark size="lg" />
      <span className="spinner" aria-hidden="true" />
      <span className="visually-hidden">{t('common.loading')}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  /** Toolbar title supplied by the page (such as the instance name); the fixed text for the route is used when there is none. */
  const [toolbarTitle, setToolbarTitle] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const firstNavRef = useRef<HTMLAnchorElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const topbarToolsRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLElement>(null);
  const onInstancePage = location.pathname.startsWith('/instances');

  const closeSidebar = useCallback((restoreFocus = true) => {
    mainRef.current?.removeAttribute('inert');
    topbarToolsRef.current?.removeAttribute('inert');
    tabBarRef.current?.removeAttribute('inert');
    setSidebarOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    // On a page change focus is handed to useRouteFocus to move to the new page heading, so it is no longer pulled back to the menu button here.
    closeSidebar(false);
    // Return to the top when switching pages, so the new page does not stay at the previous page's scroll position.
    if (mainRef.current) mainRef.current.scrollTop = 0;
    setScrolled(false);
  }, [location.pathname, closeSidebar]);

  useEffect(() => {
    if (!sidebarOpen) return;
    firstNavRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeSidebar();
        return;
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusables = [...sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [sidebarOpen, closeSidebar]);

  useEffect(() => {
    // Only the main content, the right side of the top bar and the bottom tab bar are made inert, so the menu/close button is not blocked by the whole bar.
    mainRef.current?.toggleAttribute('inert', sidebarOpen);
    topbarToolsRef.current?.toggleAttribute('inert', sidebarOpen);
    tabBarRef.current?.toggleAttribute('inert', sidebarOpen);
  }, [sidebarOpen]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1025px)');
    const onResize = () => { if (desktop.matches) closeSidebar(); };
    desktop.addEventListener('change', onResize);
    return () => desktop.removeEventListener('change', onResize);
  }, [closeSidebar]);

  function onContentScroll(event: React.UIEvent<HTMLElement>) {
    const next = event.currentTarget.scrollTop > SCROLLED_THRESHOLD;
    setScrolled((current) => (current === next ? current : next));
  }

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Ignore storage failures in restricted or private browsing contexts.
      }
      return next;
    });
  }

  const initial = user?.username ? user.username.slice(0, 1).toUpperCase() : 'A';

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <aside
        id="app-sidebar"
        ref={sidebarRef}
        className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}
        aria-label={t('shell.nav.label')}
      >
        <div className="sidebar-brand">
          <BrandMark />
          <div className="brand-info">
            <div className="brand-title">Mystry Dashboard</div>
            <div className="brand-subtitle">v{__APP_VERSION__}</div>
          </div>
        </div>

        <nav className="nav-section" onClick={() => closeSidebar()}>
          <NavLink ref={firstNavRef} to="/" end className={navClass} data-label={t('nav.overview')}>
            <LayoutGrid size={17} aria-hidden="true" />
            <span>{t('nav.overview')}</span>
          </NavLink>
          {onInstancePage && (
            <NavLink to={location.pathname} className="nav-item active" data-label={t('nav.workspace')}>
              <Terminal size={17} aria-hidden="true" />
              <span>{t('nav.workspace')}</span>
            </NavLink>
          )}

          <NavLink to="/deploy" className={navClass} data-label={t('nav.deploy')}>
            <Rocket size={17} aria-hidden="true" />
            <span>{t('nav.deploy')}</span>
          </NavLink>
          <NavLink to="/import" className={navClass} data-label={t('nav.import')}>
            <FolderDown size={17} aria-hidden="true" />
            <span>{t('nav.import')}</span>
          </NavLink>
          <NavLink to="/multiplayer" className={navClass} data-label={t('nav.multiplayer')}>
            <Globe size={17} aria-hidden="true" />
            <span>{t('nav.multiplayer')}</span>
          </NavLink>
          <NavLink to="/nodes" className={navClass} data-label={t('nav.machine')}>
            <Server size={17} aria-hidden="true" />
            <span>{t('nav.machine')}</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar" aria-hidden="true">{initial}</div>
            <div className="user-meta">
              <span className="user-name">{user?.username ?? 'admin'}</span>
              <span className="user-role">{t('shell.user.role')}</span>
            </div>
          </div>
          {/* Panel settings (language, appearance, session duration, download source, change password) are all on this page; the button stays selected while on the settings page. */}
          <NavLink
            to="/settings"
            className={({ isActive }) => `btn btn-icon btn-plain sidebar-settings${isActive ? ' active' : ''}`}
            title={t('nav.settings')}
            aria-label={t('nav.settings')}
          >
            <Settings size={16} aria-hidden="true" />
          </NavLink>
          <button className="btn btn-icon btn-plain" type="button" title={t('shell.user.signOut')} aria-label={t('shell.user.signOut')} onClick={logout}>
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>
      {remoteAccessOpen && (
        <Suspense fallback={null}>
          <RemoteAccessDialog onClose={() => setRemoteAccessOpen(false)} />
        </Suspense>
      )}

      <ToolbarTitleContext.Provider value={setToolbarTitle}>
      <div className="viewport">
        <header className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
          <div className="topbar-left">
            <button
              ref={toggleRef}
              type="button"
              className="sidebar-toggle toolbar-button"
              aria-label={sidebarOpen ? t('shell.nav.close') : t('shell.nav.open')}
              aria-expanded={sidebarOpen}
              aria-controls="app-sidebar"
              onClick={() => {
                if (sidebarOpen) closeSidebar();
                else setSidebarOpen(true);
              }}
            >
              {sidebarOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="sidebar-collapse toolbar-button"
              aria-label={sidebarCollapsed ? t('shell.nav.expand') : t('shell.nav.collapse')}
              title={sidebarCollapsed ? t('shell.nav.expand') : t('shell.nav.collapse')}
              aria-controls="app-sidebar"
              onClick={toggleSidebarCollapsed}
            >
              {sidebarCollapsed ? <PanelLeftOpen size={17} aria-hidden="true" /> : <PanelLeftClose size={17} aria-hidden="true" />}
            </button>
            <h2 className="toolbar-title">{toolbarTitle ?? t(pageTitleKeyFor(location.pathname))}</h2>
          </div>
          <div className="topbar-right" ref={topbarToolsRef}>
            <div className="toolbar-group">
              {/* Below 768px the top bar does not show this button (the title would be squeezed out); the entry moves to the "Local" page. */}
              <button
                type="button"
                className="toolbar-button toolbar-button-labeled toolbar-remote-access"
                aria-label={t('remoteAccess.entry')}
                title={t('remoteAccess.entry')}
                onClick={() => setRemoteAccessOpen(true)}
              >
                <MonitorSmartphone size={16} aria-hidden="true" />
                <span className="toolbar-label">{t('remoteAccess.entry.short')}</span>
              </button>
              <TaskCenter />
              <LanguageToggle placement="topbar" />
              <ThemeToggle placement="topbar" />
            </div>
          </div>
        </header>

        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => closeSidebar()} aria-hidden="true" tabIndex={-1} />
        )}

        <main className="content-container" ref={mainRef} onScroll={onContentScroll}>
          <div className="content-inner">{children}</div>
        </main>

        <nav className="tab-bar" ref={tabBarRef} aria-label={t('shell.tabBar.label')}>
          <NavLink to="/" end className={() => tabClass({ isActive: location.pathname === '/' || onInstancePage })}>
            <LayoutGrid size={21} aria-hidden="true" />
            <span>{t('shell.tabBar.overview')}</span>
          </NavLink>
          <NavLink to="/deploy" className={tabClass}>
            <Rocket size={21} aria-hidden="true" />
            <span>{t('shell.tabBar.deploy')}</span>
          </NavLink>
          <NavLink to="/import" className={tabClass}>
            <FolderDown size={21} aria-hidden="true" />
            <span>{t('shell.tabBar.import')}</span>
          </NavLink>
          <NavLink to="/multiplayer" className={tabClass}>
            <Globe size={21} aria-hidden="true" />
            <span>{t('shell.tabBar.multiplayer')}</span>
          </NavLink>
          <NavLink to="/nodes" className={tabClass}>
            <Server size={21} aria-hidden="true" />
            <span>{t('shell.tabBar.machine')}</span>
          </NavLink>
        </nav>
      </div>
      </ToolbarTitleContext.Provider>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, needsSetup } = useAuth();
  if (loading) return <Splash />;
  if (needsSetup || !user) return <Navigate to="/login" replace />;
  return (
    <Shell>
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </Shell>
  );
}

export function App() {
  const { user, loading, needsSetup } = useAuth();

  return (
    <>
      <RouteAnnouncer />
      <Routes>
        <Route
          path="/login"
          element={
            loading ? (
              <Splash />
            ) : user && !needsSetup ? (
              <Navigate to="/" replace />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/instances/:id/*"
          element={
            <RequireAuth>
              <InstancePage />
            </RequireAuth>
          }
        />
        <Route
          path="/deploy"
          element={
            <RequireAuth>
              <DeployPage />
            </RequireAuth>
          }
        />
        <Route
          path="/import"
          element={
            <RequireAuth>
              <ImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/multiplayer"
          element={
            <RequireAuth>
              <MultiplayerPage />
            </RequireAuth>
          }
        />
        <Route
          path="/nodes"
          element={
            <RequireAuth>
              <NodesPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
