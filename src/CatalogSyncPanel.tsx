import { useEffect, useState } from 'react'
import { api, type CatalogSyncStatus } from './api'
export function CatalogSyncPanel() {
  const [data, setData] = useState<CatalogSyncStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    let active = true, polling = false
    const refresh = async () => {
      if (polling || document.hidden) return
      polling = true
      try { const result = await api.catalogSyncStatus(); if (active) { setData(result); setError('') } }
      catch { if (active) setError('Не удалось получить состояние выгрузки') }
      finally { polling = false }
    }
    void refresh()
    const timer = setInterval(refresh, 10000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const session = data?.session
  return <section className="catalog-sync-panel"><div className="catalog-sync-panel__head"><div><p className="eyebrow">1С → Магазин</p><h2>Каталог без лишней нагрузки</h2><p>Запустите «Обновить товары на сайте» в обработке 1С. Прогресс появится здесь.</p></div><span className="catalog-sync-state">{session?.status === 'RUNNING' ? 'Выгрузка идёт' : session?.status === 'COMPLETED' ? 'Выгрузка завершена' : session?.status === 'CANCELLED' ? 'Выгрузка остановлена' : session?.status === 'EXPIRED' ? 'Нужен новый запуск' : 'Ожидаем запуск в 1С'}</span></div><div className="catalog-sync-metrics"><div><strong>{session?.processed.toLocaleString('ru-RU') || '0'}</strong><span>товаров принято</span></div><div><strong>{session?.nextBatch || 0}</strong><span>пакетов сохранено</span></div><div><strong>50</strong><span>товаров в пакете</span></div><div><strong>1</strong><span>пакет за раз</span></div></div>{session && <p className="catalog-sync-updated">{session.mode === 'DELTA' ? 'Только изменения' : 'Полная загрузка'} · Обновлено {new Date(session.updatedAt).toLocaleString('ru-RU')}{session.skipped ? ` · Пропущено дублей: ${session.skipped}` : ''}</p>}<details><summary>Как устроена выгрузка</summary><p>Первая загрузка проходит порциями. Следующие отправляют только изменившиеся данные. Фото и вложения в пакеты не входят. После обрыва обработка продолжает с сохранённого места.</p><p>Пауза между пакетами — 1 секунда. Размер одного пакета — до 512 КБ. Товары, заказы и ваши фото сохраняются при повторной загрузке.</p><p>Для установки используйте инструкцию «Каталог из 1С одной кнопкой» из папки docs проекта. Обработку нужно собрать и проверить на копии вашей базы.</p></details>{session?.status === 'RUNNING' && (!confirm ? <button className="catalog-sync-stop" onClick={() => setConfirm(true)}>Остановить этот сеанс</button> : <div className="catalog-sync-confirm"><p>Принятые товары останутся на сайте. Следующий запуск обработки потребует нового сеанса.</p><button disabled={busy} onClick={async () => { setBusy(true); try { await api.cancelCatalogSync(session.id); setData(await api.catalogSyncStatus()); setConfirm(false) } catch { setError('Не удалось остановить сеанс') } finally { setBusy(false) } }}>{busy ? 'Останавливаем…' : 'Остановить'}</button><button onClick={() => setConfirm(false)}>Продолжить выгрузку</button></div>)}{error && <p className="form-error" role="alert">{error}</p>}</section>
}
