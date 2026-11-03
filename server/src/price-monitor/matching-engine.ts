import { canonicalModel, compareItems } from './product-matching'

/**
 * Matching Engine: decides whether a parsed retailer card is strong enough
 * to attach automatically. It has no database, browser or scheduler access.
 * Persistence and human review remain the responsibility of PriceMonitorService.
 */
export class MatchingEngine {
  strongVariant(check: ReturnType<typeof compareItems>): boolean {
    // Exact SKU/GTIN alone is not enough to certify laptop capacity.
    // A notebook with a missing or different SSD must never auto-link.
    const laptop = check.ours.kind === 'laptop' || check.theirs.kind === 'laptop'
    if (laptop && (!check.ours.storage || !check.theirs.storage
      || check.ours.storage !== check.theirs.storage)) return false
    if (check.exactId && !check.conflicts.length) return true
    const accessories = ['case', 'screen-protector', 'watch-strap', 'charger', 'cable']
    const accessory = accessories.includes(check.ours.kind || '')
    const base = check.score >= 40 && !check.conflicts.length
      && Boolean(check.ours.model && canonicalModel(check.theirs.model) === canonicalModel(check.ours.model))
      && (!check.ours.storage || check.theirs.storage === check.ours.storage)
      && (!check.ours.color || check.theirs.color === check.ours.color)

    // A laptop family is not a unique model number. Require exact identifiers
    // or a complete matching hardware configuration.
    if (check.ours.kind === 'laptop' || check.theirs.kind === 'laptop') {
      const exactHardware = Boolean(
        check.ours.cpu && check.theirs.cpu && check.ours.cpu === check.theirs.cpu
        && check.ours.ram && check.theirs.ram && check.ours.ram === check.theirs.ram
        && check.ours.storage && check.theirs.storage && check.ours.storage === check.theirs.storage
        && check.ours.screenSize && check.theirs.screenSize && check.ours.screenSize === check.theirs.screenSize
      )
      return base && (check.exactId || exactHardware)
    }

    // Smartphone auto-linking requires a complete, conflict-free variant.
    // SIM may be omitted by either source; explicit disagreement blocks it.
    if (check.ours.kind === 'smartphone' || check.theirs.kind === 'smartphone') {
      return check.canAutoConfirm
    }

    // Accessory compatibility is review-only; save() requires an exact GTIN/MPN.
    if (accessory) return base && check.ours.kind === check.theirs.kind
    return base && (!check.ours.sim || !check.theirs.sim || check.theirs.sim === check.ours.sim)
  }
}
