// React 入口：挂载 App 到 DOM，包裹背景主题和动态样式
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './lib/polyfills'
import App from './App'
import { BackgroundProvider } from './context/BackgroundContext'
import DynamicStyles from './components/DynamicStyles'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackgroundProvider>
      <DynamicStyles />
      <App />
    </BackgroundProvider>
  </StrictMode>,
)
