import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/app.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('未找到 #root 容器')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
