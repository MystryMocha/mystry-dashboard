import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FolderDown, Globe, KeyRound, LayoutGrid, LogOut, Menu, MonitorSmartphone, Rocket, Server, Terminal, X } from 'lucide-react';
import { useAuth } from './auth';
import { useI18n, type MessageKey } from './i18n';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { BrandMark } from './components/BrandMark';
import { LanguageToggle } from './components/LanguageToggle';
import { TaskCenter } from './components/TaskCenter';
import { ThemeToggle } from './components/ThemeToggle';
import { useDocumentTitle } from './hooks/useDocumentTitle';
import { ToolbarTitleContext } from './hooks/useToolbarTitle';
import { useRouteFocus } from './hooks/useRouteFocus';
import { LoginPage } from './pages/LoginPage';

// 弹窗连同二维码库只在点开时加载，不进首屏包。
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

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** 内容区滚动超过这个距离后，工具栏显示页面标题和毛玻璃底。 */
const SCROLLED_THRESHOLD = 12;

function pageTitleKeyFor(pathname: string): MessageKey {
  if (pathname === '/') return 'nav.overview';
  if (pathname.startsWith('/instances')) return 'shell.pageTitle.workspace';
  if (pathname.startsWith('/deploy')) return 'nav.deploy';
  if (pathname.startsWith('/import')) return 'nav.import';
  if (pathname.startsWith('/nodes')) return 'nav.machine';
  if (pathname.startsWith('/multiplayer')) return 'nav.multiplayer';
  return 'shell.pageTitle.fallback';
}

function trimTrailingSlash(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

/** 浏览器标签标题里的页面名；实例页带实例名，由 InstancePage 自己设置，这里返回 undefined。 */
function documentTitleKeyFor(pathname: string, needsSetup: boolean): MessageKey | null | undefined {
  pathname = trimTrailingSlash(pathname);
  if (pathname === '/login') return needsSetup ? 'login.setup.title' : 'login.signin.title';
  if (pathname === '/') return 'nav.overview';
  if (/^\/instances\/[^/]+/.test(pathname)) return undefined;
  if (pathname === '/deploy') return 'nav.deploy';
  if (pathname === '/import') return 'nav.import';
  if (pathname === '/nodes') return 'nav.machine';
  if (pathname === '/multiplayer') return 'nav.multiplayer';
  return null;
}

/** 判断「是否换了页面」用的键：同一实例内切换标签不算换页。 */
function pageKeyFor(pathname: string): string {
  return /^\/instances\/[^/]+/.exec(pathname)?.[0] ?? trimTrailingSlash(pathname);
}

function DocumentTitle({ page }: { page: string | null }) {
  useDocumentTitle(page);
  return null;
}

/** 路由级无障碍：按路由设置浏览器标签标题，换页后把焦点移到新页面主标题。 */
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
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [remoteAccessOpen, setRemoteAccessOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  /** 页面给出的顶栏标题（如实例名）；没有时用路由对应的固定文案。 */
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
    // 换页时焦点交给 useRouteFocus 移到新页面标题，这里不再把焦点拉回菜单按钮。
    closeSidebar(false);
    // 切换页面时回到顶部，避免新页面停在上一页的滚动位置。
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
    // 只 inert 主内容、顶栏右侧和底部标签栏，避免菜单/关闭按钮被整栏挡住。
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

  const initial = user?.username ? user.username.slice(0, 1).toUpperCase() : 'A';

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}`}>
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
          <div className="nav-header">{t('nav.group.servers')}</div>
          <NavLink ref={firstNavRef} to="/" end className={navClass}>
            <LayoutGrid size={17} aria-hidden="true" />
            <span>{t('nav.overview')}</span>
          </NavLink>
          {onInstancePage && (
            <NavLink to={location.pathname} className="nav-item active">
              <Terminal size={17} aria-hidden="true" />
              <span>{t('nav.workspace')}</span>
            </NavLink>
          )}

          <div className="nav-header">{t('nav.group.maintain')}</div>
          <NavLink to="/deploy" className={navClass}>
            <Rocket size={17} aria-hidden="true" />
            <span>{t('nav.deploy')}</span>
          </NavLink>
          <NavLink to="/import" className={navClass}>
            <FolderDown size={17} aria-hidden="true" />
            <span>{t('nav.import')}</span>
          </NavLink>
          <NavLink to="/multiplayer" className={navClass}>
            <Globe size={17} aria-hidden="true" />
            <span>{t('nav.multiplayer')}</span>
          </NavLink>
          <NavLink to="/nodes" className={navClass}>
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
          <button className="btn btn-icon btn-plain" type="button" title={t('shell.user.changePassword')} aria-label={t('shell.user.changePassword')} onClick={() => setPasswordDialogOpen(true)}>
            <KeyRound size={16} aria-hidden="true" />
          </button>
          <button className="btn btn-icon btn-plain" type="button" title={t('shell.user.signOut')} aria-label={t('shell.user.signOut')} onClick={logout}>
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>
      {passwordDialogOpen && <ChangePasswordDialog onClose={() => setPasswordDialogOpen(false)} />}
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
            <h2 className="toolbar-title">{toolbarTitle ?? t(pageTitleKeyFor(location.pathname))}</h2>
          </div>
          <div className="topbar-right" ref={topbarToolsRef}>
            <div className="toolbar-group">
              {/* 768px 以下顶栏不放这个按钮（标题会被挤掉），入口改在「本机」页。 */}
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
