function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FBNeo ini lines look like `key value`; `.` stops before \r so CRLF files keep their endings.
export function setIniValue(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}[ \\t]+.*$`, 'm');
  const line = `${key} ${value}`;
  if (pattern.test(text)) return text.replace(pattern, line);
  if (text === '' || text.endsWith('\n')) return `${text}${line}\n`;
  return `${text}\n${line}\n`;
}
