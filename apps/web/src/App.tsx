import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FolderDown, LayoutGrid, LogOut, Menu, Rocket, Server, Terminal, X } from 'lucide-react';
import { useAuth } from './auth';
import { BrandMark } from './components/BrandMark';
import { TaskCenter } from './components/TaskCenter';
import { ThemeToggle } from './components/ThemeToggle';
import { LoginPage } from './pages/LoginPage';

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

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** 内容区滚动超过这个距离后，工具栏显示页面标题和毛玻璃底。 */
const SCROLLED_THRESHOLD = 12;

function pageTitleFor(pathname: string): string {
  if (pathname === '/') return '实例总览';
  if (pathname.startsWith('/instances')) return '实例工作台';
  if (pathname.startsWith('/deploy')) return '一键部署';
  if (pathname.startsWith('/import')) return '导入服务端';
  if (pathname.startsWith('/nodes')) return '本机环境';
  return '管理控制台';
}

const navClass = ({ isActive }: { isActive: boolean }) => `nav-item${isActive ? ' active' : ''}`;
const tabClass = ({ isActive }: { isActive: boolean }) => `tab-bar-item${isActive ? ' active' : ''}`;

function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      页面加载中…
    </div>
  );
}

function Splash() {
  return (
    <div className="splash" role="status" aria-live="polite">
      <BrandMark size="lg" />
      <span className="spinner" aria-hidden="true" />
      <span className="visually-hidden">加载中…</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const firstNavRef = useRef<HTMLAnchorElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const topbarToolsRef = useRef<HTMLDivElement>(null);
  const tabBarRef = useRef<HTMLElement>(null);
  const onInstancePage = location.pathname.startsWith('/instances');

  const closeSidebar = useCallback(() => {
    mainRef.current?.removeAttribute('inert');
    topbarToolsRef.current?.removeAttribute('inert');
    tabBarRef.current?.removeAttribute('inert');
    setSidebarOpen(false);
    toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    closeSidebar();
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
        aria-label="主导航"
      >
        <div className="sidebar-brand">
          <BrandMark />
          <div className="brand-info">
            <div className="brand-title">Mystry Dashboard</div>
            <div className="brand-subtitle">v{__APP_VERSION__}</div>
          </div>
        </div>

        <nav className="nav-section" onClick={closeSidebar}>
          <div className="nav-header">服务器</div>
          <NavLink ref={firstNavRef} to="/" end className={navClass}>
            <LayoutGrid size={17} aria-hidden="true" />
            <span>实例总览</span>
          </NavLink>
          {onInstancePage && (
            <NavLink to={location.pathname} className="nav-item active">
              <Terminal size={17} aria-hidden="true" />
              <span>当前工作台</span>
            </NavLink>
          )}

          <div className="nav-header">部署与维护</div>
          <NavLink to="/deploy" className={navClass}>
            <Rocket size={17} aria-hidden="true" />
            <span>一键部署</span>
          </NavLink>
          <NavLink to="/import" className={navClass}>
            <FolderDown size={17} aria-hidden="true" />
            <span>导入服务端</span>
          </NavLink>
          <NavLink to="/nodes" className={navClass}>
            <Server size={17} aria-hidden="true" />
            <span>本机环境</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-profile">
            <div className="user-avatar" aria-hidden="true">{initial}</div>
            <div className="user-meta">
              <span className="user-name">{user?.username ?? 'admin'}</span>
              <span className="user-role">管理员</span>
            </div>
          </div>
          <button className="btn btn-icon btn-plain" type="button" title="退出登录" aria-label="退出登录" onClick={logout}>
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <div className="viewport">
        <header className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
          <div className="topbar-left">
            <button
              ref={toggleRef}
              type="button"
              className="sidebar-toggle toolbar-button"
              aria-label={sidebarOpen ? '关闭导航菜单' : '打开导航菜单'}
              aria-expanded={sidebarOpen}
              aria-controls="app-sidebar"
              onClick={() => {
                if (sidebarOpen) closeSidebar();
                else setSidebarOpen(true);
              }}
            >
              {sidebarOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
            </button>
            <h2 className="toolbar-title">{pageTitleFor(location.pathname)}</h2>
          </div>
          <div className="topbar-right" ref={topbarToolsRef}>
            <div className="toolbar-group">
              <TaskCenter />
              <ThemeToggle placement="topbar" />
            </div>
          </div>
        </header>

        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={closeSidebar} aria-hidden="true" tabIndex={-1} />
        )}

        <main className="content-container" ref={mainRef} onScroll={onContentScroll}>
          <div className="content-inner">{children}</div>
        </main>

        <nav className="tab-bar" ref={tabBarRef} aria-label="快捷导航">
          <NavLink to="/" end className={() => tabClass({ isActive: location.pathname === '/' || onInstancePage })}>
            <LayoutGrid size={21} aria-hidden="true" />
            <span>总览</span>
          </NavLink>
          <NavLink to="/deploy" className={tabClass}>
            <Rocket size={21} aria-hidden="true" />
            <span>部署</span>
          </NavLink>
          <NavLink to="/import" className={tabClass}>
            <FolderDown size={21} aria-hidden="true" />
            <span>导入</span>
          </NavLink>
          <NavLink to="/nodes" className={tabClass}>
            <Server size={21} aria-hidden="true" />
            <span>本机</span>
          </NavLink>
        </nav>
      </div>
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
        path="/nodes"
        element={
          <RequireAuth>
            <NodesPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
