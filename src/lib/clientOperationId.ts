const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hashOperationInput(stableInput: string): Uint8Array {
  let hash = 2166136261;
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => {
    const code = stableInput.charCodeAt(index % Math.max(1, stableInput.length));
    hash = Math.imul(hash ^ code ^ index, 16777619);
    return (hash >>> ((index % 4) * 8)) & 255;
  });

  // Preserve the historical deterministic output for inputs up to 16 UTF-16
  // code units, but fold every trailing code unit into the UUID. The previous
  // implementation silently ignored everything after index 15, so operation
  // keys with a shared 16-character prefix collided and could replay the wrong
  // idempotent create result.
  for (let index = 16; index < stableInput.length; index += 1) {
    hash = Math.imul(hash ^ stableInput.charCodeAt(index) ^ index, 16777619);
    const lane = index % bytes.length;
    const shifted = (hash >>> ((index % 4) * 8)) & 255;
    bytes[lane] = bytes[lane]! ^ shifted;
    const spreadLane = (lane + 7) % bytes.length;
    bytes[spreadLane] = (bytes[spreadLane]! + (hash & 255) + index) & 255;
  }
  return bytes;
}

export function createClientOperationId(stableInput?: string): string {
  const bytes = stableInput
    ? hashOperationInput(stableInput)
    : (() => {
        const generated = new Uint8Array(16);
        const cryptoApi = globalThis.crypto;
        if (cryptoApi?.getRandomValues) return cryptoApi.getRandomValues(generated);
        return hashOperationInput(`${Date.now()}:${Math.random()}:${Math.random()}`);
      })();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isClientOperationId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
