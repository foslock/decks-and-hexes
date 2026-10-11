import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/screens.css'
import './styles/overlays.css'
import './styles/game.css'
import './styles/cards.css'
import './styles/tutorial.css'
import './styles/solo.css'
import { installCursors } from './utils/cursors'

installCursors()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
