// djb2-XOR hash — deterministic, no Date/Math.random dependency
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h);
}

export function colorFromString(s: string, saturation = 65, lightness = 50): string {
  const hue = hashString(s) % 360;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}
