interface SerializedOperation<T> {
  (): Promise<T>;
}

var mutationTail: Promise<unknown> = Promise.resolve();

/**
 * Prevents same-isolate read/modify/write races. Plugin storage does not expose
 * compare-and-swap, so this is deliberately not presented as cross-isolate
 * transaction safety.
 */
export async function serializeMutation<T>(operation: SerializedOperation<T>): Promise<T> {
  var queued = mutationTail.then(operation, operation);
  mutationTail = queued.then(
    function() { return undefined; },
    function() { return undefined; }
  );
  return await queued;
}
