export function failureIncludes(failure, candidate) {
  if (failure === candidate) return true;
  return failure instanceof AggregateError
    && failure.errors.some(nested => failureIncludes(nested, candidate));
}

export async function finalizeResponseOverlapCleanup(originalFailure, cleanupSteps, message) {
  const failures = originalFailure ? [originalFailure] : [];
  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      if (!failures.some(failure => failureIncludes(failure, error))) failures.push(error);
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, message);
  if (failures.length === 1) throw failures[0];
}
