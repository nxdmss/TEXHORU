export function TexhoruBrand({ subtitle }: { subtitle?: string }) {
  return <span className="texhoru-brand" aria-hidden="true">
    <span className="texhoru-brand__wordmark">TEXHO<span className="brand-ru">RU</span></span>
    {subtitle && <small className="texhoru-brand__subtitle">{subtitle}</small>}
  </span>
}
