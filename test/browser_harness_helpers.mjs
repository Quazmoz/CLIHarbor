export function parseDevToolsActivePort(raw) {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^\d{1,5}$/.test(firstLine)) {
    return undefined;
  }
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return port;
}
