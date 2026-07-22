import './assets/base.css'
import './assets/lookup.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Root from './Root'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
