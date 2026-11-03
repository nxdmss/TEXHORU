/** A negative search is a workload decision, not proof of permanent absence. */
export type SearchEvidence = {
  linksFound: number
  searchPages?: number
  rankedLinks?: number
  cardsParsed: number
  rejectedCards: string[]
}
export function canDeclareNoMatch(traces: SearchEvidence[]): boolean {
  if (!traces.some(row => (row.searchPages ?? 0) > 0 && row.linksFound > 0)) return false
  return traces.every(row => {
    if ((row.rankedLinks ?? 0) > row.cardsParsed) return false
    // Only no-candidate ranking is an acceptable negative diagnostic.
    return row.rejectedCards.every(message =>
      /Поиск 05\.ru открылся .*строгий и расширенный подбор не нашли кандидатов/.test(message))
  })
}
