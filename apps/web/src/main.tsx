import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { useI18n, watchBrowserLocale } from './i18n';
import { watchSystemAppearance } from './theme';
import './styles.css';

watchSystemAppearance();
watchBrowserLocale();

function ErrorScreen({ error }: { error: Error }) {
  const { t } = useI18n();
  return (
    <div className="splash" role="alert">
      <div className="splash-card">
        <h1 className="splash-title">{t('shell.error.title')}</h1>
        <p className="splash-text">{String(error.message || error)}</p>
        <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
          {t('shell.error.reload')}
        </button>
      </div>
    </div>
  );
}

/** 渲染期异常兜底，避免整页白屏且无法恢复。 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('页面渲染异常', error, info);
  }

  render() {
    if (this.state.error) return <ErrorScreen error={this.state.error} />;
    return this.props.children;
  }
}

const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </AuthProvider>
    ),
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
