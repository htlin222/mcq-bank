import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BookmarkProvider } from './hooks/useBookmarkSet';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <BookmarkProvider>
        <App />
      </BookmarkProvider>
    </BrowserRouter>
  </React.StrictMode>
);
