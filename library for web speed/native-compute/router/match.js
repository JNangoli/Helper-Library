// Route patterns: '/', '/products', '/products/:id', '/files/*' (the rest of the path, as params['*']).

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function compileRoute(route) {
  const keys = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        keys.push('*');
        return '(.*)';
      }
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return escape(segment);
    })
    .join('/');
  return { route, keys, regex: new RegExp(`^${source}/?$`, 'i') };
}

/** First route matching the pathname: { route, params } or null. */
export function matchRoute(compiled, pathname) {
  for (const { route, keys, regex } of compiled) {
    const m = regex.exec(pathname);
    if (!m) continue;
    const params = {};
    keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1] ?? '');
    });
    return { route, params };
  }
  return null;
}
