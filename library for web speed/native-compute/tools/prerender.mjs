#!/usr/bin/env node
// Build-time SEO: writes one HTML file per page with its own <title>, description, canonical,
// link-preview tags and structured data, plus sitemap.xml and robots.txt. Crawlers and link
// previews that don't run JavaScript then see the right metadata. No dependencies (Node 18+).
//
//   npm run build && node src/native-compute/tools/prerender.mjs --build build --config seo.config.mjs
//
// seo.config.mjs:
//   export default {
//     siteUrl: 'https://example.com',
//     pages: async () => [                       // or a plain array
//       { path: '/', head: { title: 'Shop', description: '...' }, priority: 1 },
//       ...(await getProducts()).map((p) => ({
//         path: `/products/${p.id}`,
//         head: { title: p.name, description: p.summary, image: p.photo, type: 'product', jsonLd: {...} },
//         lastmod: p.updatedAt,
//       })),
//     ],
//     robots: { disallow: ['/account'] },        // optional
//     render: async (page) => ({ html, data }),  // optional: full content from your server renderer
//   };
//
// Safe to run again on the same build: earlier output is replaced, not stacked.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { headToHtml, serializeData } from '../router/head.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const buildDir = path.resolve(args.build ?? 'build');
const configPath = path.resolve(args.config ?? 'seo.config.mjs');
const rootId = args.root ?? 'root';

const config = (await import(pathToFileURL(configPath).href)).default;
const siteUrl = String(config.siteUrl ?? '').replace(/\/$/, '');
if (!siteUrl) throw new Error('seo.config: siteUrl is required, e.g. "https://example.com"');
const pages = typeof config.pages === 'function' ? await config.pages() : (config.pages ?? []);

const templatePath = path.join(buildDir, 'index.html');
const template = await readFile(templatePath, 'utf8');

// Remove anything a previous run (or the original template) put there that we now manage.
const clean = (html) =>
  html
    .replace(/\s*<script[^>]*data-nc-head[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s*<[^>]+data-nc-head[^>]*>/gi, '')
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+name="description"[^>]*>/gi, '')
    .replace(/\s*<meta\s+(property|name)="(og:|twitter:)[^"]*"[^>]*>/gi, '')
    .replace(/\s*<link\s+rel="canonical"[^>]*>/gi, '')
    .replace(/\s*<script>window\.__NC_DATA__=[\s\S]*?<\/script>/i, '');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const base = clean(template);
let written = 0;
for (const page of pages) {
  if (!page.path?.startsWith('/')) throw new Error(`Page path must start with "/": ${page.path}`);
  let html = base.replace('</head>', `    ${headToHtml(page.head ?? {}, { siteUrl, pathname: page.path })}\n  </head>`);
  if (config.render) {
    const out = await config.render(page);
    if (out?.html)
      html = html.replace(new RegExp(`<div id="${rootId}">\\s*</div>`), `<div id="${rootId}">${out.html}</div>`);
    if (out && 'data' in out) html = html.replace('</body>', `${serializeData(out.data)}</body>`);
  }
  const relative = decodeURIComponent(page.path).replace(/^\/+|\/+$/g, '');
  const target = path.resolve(buildDir, relative, 'index.html');
  if (!target.startsWith(buildDir + path.sep)) throw new Error(`Page path escapes the build folder: ${page.path}`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html);
  written++;
}

const listed = pages.filter((p) => p.sitemap !== false && !/noindex/i.test(p.head?.robots ?? ''));
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${listed
  .map((p) => {
    const parts = [`<loc>${xml(siteUrl + p.path)}</loc>`];
    if (p.lastmod) parts.push(`<lastmod>${xml(new Date(p.lastmod).toISOString().slice(0, 10))}</lastmod>`);
    if (p.changefreq) parts.push(`<changefreq>${xml(p.changefreq)}</changefreq>`);
    if (p.priority !== undefined) parts.push(`<priority>${xml(p.priority)}</priority>`);
    return `  <url>${parts.join('')}</url>`;
  })
  .join('\n')}
</urlset>
`;
await writeFile(path.join(buildDir, 'sitemap.xml'), sitemap);

const robotsPath = path.join(buildDir, 'robots.txt');
const ownRobots = existsSync(robotsPath) && !(await readFile(robotsPath, 'utf8')).includes('# native-compute');
if (!ownRobots || args['overwrite-robots'] !== undefined) {
  const rules = (config.robots?.disallow ?? []).map((p) => `Disallow: ${p}`);
  await writeFile(
    robotsPath,
    [
      '# native-compute',
      'User-agent: *',
      ...(rules.length ? rules : ['Allow: /']),
      `Sitemap: ${siteUrl}/sitemap.xml`,
      '',
    ].join('\n'),
  );
}

console.log(
  `prerender: ${written} pages, sitemap.xml (${listed.length} URLs)${ownRobots ? '' : ', robots.txt'} → ${buildDir}`,
);
