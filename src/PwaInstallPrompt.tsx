import { useEffect, useState } from 'react'
import { Icon } from './Icon'

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function PwaInstallPrompt() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null)
  const [hidden, setHidden] = useState(() => sessionStorage.getItem('texhoru_install_hidden') === '1')

  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault()
      setPrompt(event as InstallPromptEvent)
    }
    const installed = () => setPrompt(null)
    window.addEventListener('beforeinstallprompt', capture)
    window.addEventListener('appinstalled', installed)
    return () => {
      window.removeEventListener('beforeinstallprompt', capture)
      window.removeEventListener('appinstalled', installed)
    }
  }, [])

  if (!prompt || hidden) return null
  const dismiss = () => { sessionStorage.setItem('texhoru_install_hidden', '1'); setHidden(true) }
  const install = async () => {
    await prompt.prompt()
    const choice = await prompt.userChoice
    if (choice.outcome === 'accepted') setPrompt(null)
    else dismiss()
  }
  return <aside className="pwa-install" aria-label="Установка приложения TEXHORU">
    <img className="pwa-install__mark" src="/pwa-ru.svg" alt="" aria-hidden="true" />
    <span><strong>TEXHORU на экране телефона</strong><small>Каталог откроется как приложение</small></span>
    <button type="button" className="pwa-install__action" onClick={install}>Установить</button>
    <button type="button" className="pwa-install__close" onClick={dismiss} aria-label="Не сейчас"><Icon name="close" /></button>
  </aside>
}
