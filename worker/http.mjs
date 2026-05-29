export function wantsJsonResponse(request) {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('application/json') || !accept.includes('text/html');
}

export function wantsHtmlResponse(request) {
  return !wantsJsonResponse(request);
}
