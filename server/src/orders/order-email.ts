type OrderMailInput = {
  number: number
  trackingToken: string
  customerName: string
  total: number
  deliveryMethod: string
  items: Array<{ name: string; quantity: number; price: number }>
}

const statusLabels: Record<string, string> = {
  NEW: 'Заказ принят', AWAITING_PAYMENT: 'Ожидает оплаты', PAID: 'Оплачен', ASSEMBLING: 'Собирается',
  READY: 'Готов к получению', DELIVERING: 'Передан в доставку', COMPLETED: 'Получен', CANCELLED: 'Отменён',
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))
const money = (value: number) => new Intl.NumberFormat('ru-RU').format(value) + ' ₽'

export function orderEmail(order: OrderMailInput, kind: string, status: string, publicUrl: string) {
  const origin = new URL(publicUrl)
  const trackingUrl = new URL(`/order/${encodeURIComponent(order.trackingToken)}`, origin).toString()
  const created = kind === 'ORDER_CREATED'
  const expired = kind === 'RESERVATION_EXPIRED'
  const title = created ? `Заказ №${order.number} принят` : expired ? `Заказ №${order.number} отменён` : `Заказ №${order.number}: ${statusLabels[status] || status}`
  const intro = created
    ? 'Мы получили заказ и временно зарезервировали товары. Менеджер проверит наличие и свяжется с вами.'
    : expired ? 'Срок временного резерва закончился. Товары снова доступны для заказа.' : `Новый статус: ${statusLabels[status] || status}.`
  const itemText = order.items.map(item => `${item.name} × ${item.quantity} — ${money(item.price * item.quantity)}`).join('\n')
  const itemHtml = order.items.map(item => `<tr><td style="padding:10px 0;border-bottom:1px solid #ecece8">${escape(item.name)} × ${item.quantity}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #ecece8;white-space:nowrap">${money(item.price * item.quantity)}</td></tr>`).join('')
  return {
    subject: `${title} — TEXHORU`,
    text: `Здравствуйте, ${order.customerName}!\n\n${intro}\n\n${itemText}\n\nИтого: ${money(order.total)}\nПолучение: ${order.deliveryMethod === 'PICKUP' ? 'самовывоз' : 'доставка'}\n\nСтатус заказа: ${trackingUrl}`,
    html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f6f6f3;font-family:Arial,sans-serif;color:#171717"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:36px 14px"><table role="presentation" width="580" cellspacing="0" cellpadding="0" style="width:100%;max-width:580px"><tr><td style="padding-bottom:24px;font-size:26px;font-weight:800">TEXHO<span style="color:#d6001c">RU</span></td></tr><tr><td style="height:4px;background:#d6001c"></td></tr><tr><td style="background:#fff;padding:32px 26px"><p style="font-size:11px;letter-spacing:2px;color:#707069">ЗАКАЗ №${order.number}</p><h1 style="font-size:28px;line-height:1.2;margin:20px 0">${escape(title)}</h1><p style="font-size:15px;line-height:1.7">Здравствуйте, ${escape(order.customerName)}!</p><p style="font-size:15px;line-height:1.7;color:#55554f">${escape(intro)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0;font-size:13px">${itemHtml}<tr><td style="padding-top:16px;font-weight:bold">Итого</td><td align="right" style="padding-top:16px;font-size:18px;font-weight:bold">${money(order.total)}</td></tr></table><table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:26px"><tr><td bgcolor="#171717"><a href="${escape(trackingUrl)}" style="display:inline-block;padding:15px 22px;color:#fff;text-decoration:none;font-weight:bold">Открыть заказ →</a></td></tr></table></td></tr><tr><td style="padding-top:20px;font-size:11px;line-height:1.6;color:#707069">TEXHORU · Служебное письмо о вашем заказе</td></tr></table></td></tr></table></body></html>`,
  }
}
