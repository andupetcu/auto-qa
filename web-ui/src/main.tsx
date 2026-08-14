import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TokenGate } from './auth/TokenGate';
import { AppShell } from './layout/AppShell';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { MatrixPage } from './pages/MatrixPage';
import { CoveragePage } from './pages/CoveragePage';

import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <FluentProvider theme={webDarkTheme} style={{ height: '100vh' }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <TokenGate>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Navigate to="/runs" replace />} />
                <Route path="runs" element={<RunsPage />} />
                <Route path="runs/:runId" element={<RunDetailPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="matrix" element={<MatrixPage />} />
                <Route path="coverage" element={<CoveragePage />} />
                <Route path="*" element={<Navigate to="/runs" replace />} />
              </Route>
            </Routes>
          </TokenGate>
        </BrowserRouter>
      </QueryClientProvider>
    </FluentProvider>
  </StrictMode>,
);
