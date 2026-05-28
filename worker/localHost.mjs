export function canonicalLocalRequestUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (url.hostname !== 'localhost') {
    return null;
  }
  url.hostname = '127.0.0.1';
  return url.toString();
}
