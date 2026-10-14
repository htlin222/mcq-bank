import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BookmarkProvider } from './hooks/useBookmarkSet';
import './styles.css';
// Registers the service worker and wires the SW → page auth-required signal.
// Must run before React mounts; no-op in dev and where SW is unsupported.
import './lib/pwa';
import { installAttemptFlusher } from './lib/attemptFlusher';
import { installExamAttemptFlusher } from './lib/examAttemptFlusher';
import { installSmearAttemptFlusher } from './lib/smearAttemptFlusher';

// 補送送不出去的作答。掛在 React 之外,因為它要活得比任何一個畫面久 ——
// 補送的前提就是「使用者已經離開那一題了」(見 lib/attemptOutbox.ts)。
// 三條佇列各打各的端點,不能併成一條。
installAttemptFlusher();
installExamAttemptFlusher();
installSmearAttemptFlusher();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <BookmarkProvider>
        <App />
      </BookmarkProvider>
    </BrowserRouter>
  </React.StrictMode>
);
