export type AnswerSelection = number | number[]

export function answerIndexes(
  selection: AnswerSelection | null | undefined,
): number[] {
  if (selection == null) return []
  return Array.from(new Set(Array.isArray(selection) ? selection : [selection]))
}

/**
 * A multiple-answer response is correct only when it contains the complete
 * answer set. Selection order does not matter, but a partial set is wrong.
 */
export function isAnswerSelectionCorrect(
  selection: AnswerSelection | null,
  solution: AnswerSelection,
): boolean {
  if (selection == null) return false

  const selected = answerIndexes(selection)
  const correct = answerIndexes(solution)

  return (
    selected.length > 0 &&
    selected.length === correct.length &&
    selected.every((index) => correct.includes(index))
  )
}

export function answerSelectionText(
  answers: string[],
  selection: AnswerSelection | null,
): string {
  const indexes = answerIndexes(selection)
  if (indexes.length === 0) return "Not answered"
  return indexes.map((index) => answers[index] ?? String(index)).join(", ")
}
