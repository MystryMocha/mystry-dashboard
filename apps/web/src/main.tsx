import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AuthProvider } from './auth';
import { App } from './App';
import { watchSystemAppearance } from './theme';
import './styles.css';

watchSystemAppearance();

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
    if (this.state.error) {
      return (
        <div className="splash" role="alert">
          <div className="splash-card">
            <h1 className="splash-title">页面出现异常</h1>
            <p className="splash-text">{String(this.state.error.message || this.state.error)}</p>
            <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </div>
      );
    }
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
