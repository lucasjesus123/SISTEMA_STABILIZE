import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';
import './app.css';

const raiz = document.getElementById('root');
if (raiz === null) {
  throw new Error('elemento #root não encontrado no documento');
}

createRoot(raiz).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
