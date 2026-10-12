import { createRoot } from 'react-dom/client';
import { App } from './App.js';

// StrictMode is deliberately left off: LegacyShell's bootUi() attaches
// one-time global listeners (hashchange, action delegation, keyboard
// shortcuts) that are not written to survive a double-invoked effect.
createRoot(document.getElementById('root')!).render(<App />);
