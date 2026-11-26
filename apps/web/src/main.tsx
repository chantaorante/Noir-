import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './design/tokens.css';
import './design/base.css';
import './design/app.css';
import { App } from './App';
import { Router } from './lib/router';
import { ToastHost } from './lib/ui';
import { SessionProvider } from './state/session';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <ToastHost>
        <SessionProvider>
          <App />
        </SessionProvider>
      </ToastHost>
    </Router>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
