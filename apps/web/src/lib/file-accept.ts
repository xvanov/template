/** Does a file satisfy an <input accept="..."> string? (".csv", "image/*", "text/plain") */
export function matchesAccept(
  file: { name: string; type: string },
  accept: string | undefined,
): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith(".")) return name.endsWith(rule);
      if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
}
