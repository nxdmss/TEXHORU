export function TexhoruBrand({ subtitle, section, sectionCount }: { subtitle?: string; section?: string; sectionCount?: number }) {
  return <span className="texhoru-brand" aria-hidden="true">
    <span className="texhoru-brand__line"><span className="texhoru-brand__wordmark">TEXHO<span className="brand-ru">RU</span></span>
      {section && <span className={'texhoru-brand__section' + (sectionCount !== undefined ? ' texhoru-brand__section--counted' : '')}>{section}{sectionCount !== undefined && <strong className="texhoru-brand__section-count">{sectionCount}</strong>}</span>}</span>
    {subtitle && <small className="texhoru-brand__subtitle">{subtitle}</small>}
  </span>
}
