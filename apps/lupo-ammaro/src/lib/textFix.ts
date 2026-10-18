/** Corregge ? al posto di × nei nomi workout (encoding perso). */
export function fixCorruptMultiply(text: string): string {
  return text.replace(/(\d)\?(\d)/g, "$1×$2");
}

export function fixWorkoutText(workout: { name: string; description?: string }) {
  return {
    name: fixCorruptMultiply(workout.name),
    description: fixCorruptMultiply(workout.description ?? ""),
  };
}
