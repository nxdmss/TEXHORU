import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@fontsource/ibm-plex-mono/700.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './brand-system.css'
import './admin-control.css'
import './admin-responsive.css'
import './product-image.css'
import './storefront-refresh.css'
import './storefront-layout.css'
import './experience-upgrade.css'
import './mobile-overhaul.css'
import './icon-system.css'
import './desktop-polish.css'
import './admin-desktop.css'
import './site-finish.css'
import './brand-navigation.css'
import './transparent-products.css'
import './design-system-v2.css'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
