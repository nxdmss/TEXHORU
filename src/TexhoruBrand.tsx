export function TexhoruBrand({ subtitle, section }: { subtitle?: string; section?: string }) {
  return <span className="texhoru-brand" aria-hidden="true">
    <span className="texhoru-brand__line"><span className="texhoru-brand__wordmark">TEXHO<span className="brand-ru">RU</span></span>
      {section && <span className="texhoru-brand__section">{section}</span>}</span>
    {subtitle && <small className="texhoru-brand__subtitle">{subtitle}</small>}
  </span>
}
