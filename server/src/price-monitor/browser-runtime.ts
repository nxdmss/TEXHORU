import { chromium } from 'playwright'

export async function launchParserBrowser(source: string) {
  // Edge uses an isolated temporary profile on office Windows machines.
  if (process.platform === 'win32') {
    try { return await chromium.launch({ channel: 'msedge', headless: true }) } catch { /* Try the bundled browser. */ }
  }
  try {
    // With --only-shell the full Chromium executablePath() does not exist.
    // Let Playwright select its installed headless shell instead of rejecting it.
    return await chromium.launch({ headless: true })
  } catch (error) {
    const hint = process.platform === 'win32' ? 'Установи Microsoft Edge или браузер Playwright.'
      : 'Проверь установку браузера Playwright на сервере.'
    throw new Error(`Не удалось запустить браузер фонового парсера ${source}. ${hint} ${error instanceof Error ? error.message : String(error)}`)
  }
}
