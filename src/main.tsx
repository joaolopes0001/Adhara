import React from 'react';
import ReactDOM from 'react-dom/client';
// Before App, so the saved language is on <html lang> before React mounts.
import './i18n';
import App from './App';
import './style.css';
import './dark.css';
import './brand.css';
import './map-workspace.css';
import './changes.css';
import './diagnosis.css';
import './projects.css';
import './frame.css';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
