import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/app.css';
import { App } from './App';
import { init } from './store/actions';
import { useStore } from './store/store';
import { errorText } from './lib/api';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

init().catch((e) => useStore.setState({ bootError: errorText(e) }));
