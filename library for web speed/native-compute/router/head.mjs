// Head tags for SEO and link previews: one builder used by the browser (applyHead), servers
// (headToHtml) and the build-time prerender tool. Plain JavaScript with no imports, so Node
// can load it directly.
//
// head = {
//   title, description,
//   canonical,                 // absolute URL; defaults to siteUrl + current path when siteUrl is set
//   robots,                    // e.g. 'noindex' (the not-found screen sets this automatically)
//   image, imageAlt,           // preview image for social / chat apps (absolute URL is best)
//   type,                      // og:type, default 'website' ('article', 'product', ...)
//   siteName, locale, twitter, // og:site_name, og:locale, twitter:site (@handle)
//   alternates: [{ hreflang, href }],   // other languages
//   jsonLd: {...} | [...],     // structured data (schema.org) for rich results
//   meta: [{ name | property, content }], links: [{ rel, href, ... }],   // anything else
// }

const ATTR = 'data-nc-head';

const absolute = (href, siteUrl) => {
  if (!href || !siteUrl || /^[a-z]+:/i.test(href)) return href;
  return siteUrl.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`);
};

/** The tags for a head object: [{ tag, attrs, text? }] (title is returned separately). */
export function buildHead(head = {}, { siteUrl, pathname } = {}) {
  const tags = [];
  const meta = (key, name, content) => {
    if (content !== undefined && content !== null && content !== '')
      tags.push({ tag: 'meta', attrs: { [key]: name, content: String(content) } });
  };
  const canonical =
    absolute(head.canonical, siteUrl) ?? (siteUrl && pathname ? absolute(pathname, siteUrl) : undefined);
  const image = absolute(head.image, siteUrl);

  meta('name', 'description', head.description);
  meta('name', 'robots', head.robots);
  if (canonical) tags.push({ tag: 'link', attrs: { rel: 'canonical', href: canonical } });
  for (const alt of head.alternates ?? []) {
    tags.push({ tag: 'link', attrs: { rel: 'alternate', hreflang: alt.hreflang, href: absolute(alt.href, siteUrl) } });
  }
  meta('property', 'og:title', head.ogTitle ?? head.title);
  meta('property', 'og:description', head.ogDescription ?? head.description);
  meta('property', 'og:type', head.type ?? 'website');
  meta('property', 'og:url', canonical);
  meta('property', 'og:image', image);
  meta('property', 'og:image:alt', head.imageAlt);
  meta('property', 'og:site_name', head.siteName);
  meta('property', 'og:locale', head.locale);
  meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
  meta('name', 'twitter:site', head.twitter);
  for (const m of head.meta ?? []) meta(m.property ? 'property' : 'name', m.property ?? m.name, m.content);
  for (const l of head.links ?? []) tags.push({ tag: 'link', attrs: { ...l } });
  for (const data of [].concat(head.jsonLd ?? [])) {
    // "<" escaped so the JSON can never close the <script> early
    tags.push({
      tag: 'script',
      attrs: { type: 'application/ld+json' },
      text: JSON.stringify(data).replace(/</g, '\\u003c'),
    });
  }
  return { title: head.title, tags };
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HTML for the server or the prerender tool: <title> plus the tags, each marked as managed. */
export function headToHtml(head, options) {
  const { title, tags } = buildHead(head, options);
  const parts = title ? [`<title>${escapeHtml(title)}</title>`] : [];
  for (const { tag, attrs, text } of tags) {
    const a = Object.entries(attrs)
      .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
      .join('');
    parts.push(tag === 'script' ? `<script ${ATTR}${a}>${text}</script>` : `<${tag} ${ATTR}${a}>`);
  }
  return parts.join('\n    ');
}

/** In the browser: replace the managed head tags with these (the page's own tags are left alone). */
export function applyHead(head, options) {
  if (typeof document === 'undefined') return;
  const { title, tags } = buildHead(head, options);
  if (title) document.title = title;
  for (const el of document.head.querySelectorAll(`[${ATTR}]`)) el.remove();
  // Tags written by hand in index.html (description, og:*) would duplicate ours: replace them.
  for (const { tag, attrs } of tags) {
    const key = attrs.name
      ? `name="${attrs.name}"`
      : attrs.property
        ? `property="${attrs.property}"`
        : attrs.rel === 'canonical'
          ? 'rel="canonical"'
          : null;
    if (key) document.head.querySelector(`${tag}[${key}]`)?.remove();
  }
  for (const { tag, attrs, text } of tags) {
    const el = document.createElement(tag);
    el.setAttribute(ATTR, '');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text) el.textContent = text;
    document.head.appendChild(el);
  }
}

/** Safe <script> that hands server-loaded data to the browser for hydration. */
export function serializeData(data, name = '__NC_DATA__') {
  return `<script>window.${name}=${JSON.stringify(data ?? null).replace(/</g, '\\u003c')}</script>`;
}
