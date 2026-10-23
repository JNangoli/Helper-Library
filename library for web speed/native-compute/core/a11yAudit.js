// Development check for common accessibility problems. Run automatically in development by
// autoNative(); silent in production. Returns the problems found (and logs them).

const INTERACTIVE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [tabindex]:not([tabindex="-1"])';

function accessibleName(el) {
  const label = el.getAttribute('aria-label');
  if (label?.trim()) return label.trim();
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (el.matches('input, select, textarea')) {
    if (el.id && document.querySelector(`label[for="${globalThis.CSS?.escape ? CSS.escape(el.id) : el.id}"]`)?.textContent.trim())
      return 'label';
    if (el.closest('label')?.textContent.trim()) return 'label';
    if (el.matches('input[type="submit"], input[type="button"], input[type="reset"]') && el.value) return el.value;
    return el.getAttribute('placeholder') ? '' : (el.getAttribute('title') ?? '');
  }
  const text = el.textContent?.trim();
  if (text) return text;
  const img = el.querySelector('img[alt]:not([alt=""]), svg[aria-label], [role="img"][aria-label]');
  if (img) return img.getAttribute('alt') || img.getAttribute('aria-label');
  return el.getAttribute('title') ?? '';
}

const describe = (el) => {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
};

export function auditA11y({ root = document.body, minTarget = 24, log = true } = {}) {
  const problems = [];
  const add = (kind, element, message) => problems.push({ kind, element, message });

  if (!document.documentElement.getAttribute('lang')) {
    add(
      'lang',
      document.documentElement,
      '<html> has no lang attribute: screen readers may use the wrong voice (add lang="en" or your language)',
    );
  }
  for (const img of root.querySelectorAll('img:not([alt])')) {
    if (img.closest('[aria-hidden="true"]')) continue;
    add('img-alt', img, `${describe(img)} has no alt: describe the image, or use alt="" if it's decorative`);
  }
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) continue;
    if (!accessibleName(el)) {
      add('name', el, `${describe(el)} has no accessible name: add visible text, aria-label, or a <label>`);
    }
    const tabindex = Number(el.getAttribute('tabindex'));
    if (tabindex > 0)
      add('tabindex', el, `${describe(el)} has tabindex="${tabindex}": positive values scramble keyboard order; use 0`);
    // Tap target size (WCAG 2.5.8): skip links inside running text, which are exempt.
    const inline = el.matches('a') && getComputedStyle(el).display === 'inline';
    const rect = el.getBoundingClientRect();
    if (!inline && rect.width > 0 && rect.height > 0 && (rect.width < minTarget || rect.height < minTarget)) {
      add(
        'target-size',
        el,
        `${describe(el)} is ${Math.round(rect.width)}×${Math.round(rect.height)}px: tap targets should be at least ${minTarget}×${minTarget}px`,
      );
    }
  }
  const ids = new Map();
  for (const el of root.querySelectorAll('[id]')) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
  for (const [id, n] of ids)
    if (n > 1) add('duplicate-id', null, `id="${id}" is used ${n} times: labels and links pointing to it break`);

  if (log && problems.length) {
    console.groupCollapsed(`[native-compute] ${problems.length} accessibility issue(s)`);
    problems.forEach((p) => console.warn(p.message, p.element ?? ''));
    console.groupEnd();
  }
  return problems;
}
