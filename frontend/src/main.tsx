import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BookmarkProvider } from './hooks/useBookmarkSet';
import './styles.css';
// Registers the service worker and wires the SW → page auth-required signal.
// Must run before React mounts; no-op in dev and where SW is unsupported.
import './lib/pwa';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <BookmarkProvider>
        <App />
      </BookmarkProvider>
    </BrowserRouter>
  </React.StrictMode>
);
