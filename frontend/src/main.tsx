import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
