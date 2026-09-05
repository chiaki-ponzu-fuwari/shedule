#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const rootArgument = process.argv.indexOf('--root');
const root = path.resolve(
  rootArgument >= 0 && process.argv[rootArgument + 1]
    ? process.argv[rootArgument + 1]
    : process.cwd(),
);
const publicDirectory = path.join(root, 'legal-site/public');
const pages = [
  'index',
  'privacy',
  'terms',
  'support',
  'delete-account',
  'community-guidelines',
];
const legalPageTargets = pages.filter((name) => name !== 'index');
const allowedExternalLinks = new Set([
  'https://developers.google.com/terms/api-services-user-data-policy',
]);
const failures = [];

function fail(message) {
  failures.push(message);
}

function decodeAttribute(value) {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);?/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&(colon|sol|period|amp);/gi, (_, name) => ({
      colon: ':',
      sol: '/',
      period: '.',
      amp: '&',
    })[name.toLowerCase()]);
}

function parseTags(html) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const tags = [];
  const pattern = /<([a-z][\w:-]*)(\s[^<>]*?)?\s*\/?>/gi;
  for (const match of withoutComments.matchAll(pattern)) {
    const attributes = {};
    const source = match[2] ?? '';
    const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const attribute of source.matchAll(attributePattern)) {
      attributes[attribute[1].toLowerCase()] = decodeAttribute(
        attribute[2] ?? attribute[3] ?? attribute[4] ?? '',
      );
    }
    tags.push({ name: match[1].toLowerCase(), attributes });
  }
  return { tags, withoutComments };
}

function classContains(attributes, expected) {
  return (attributes.class ?? '').split(/\s+/).includes(expected);
}

function validateUrl(value, location) {
  if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) {
    fail(`${location} has an empty or malformed URL`);
    return;
  }
  if (value === '#main') return;
  if (/^\.\/[a-z0-9][a-z0-9._/-]*$/i.test(value) && !value.includes('..')) return;
  if (/^mailto:herac\.7\.app@gmail\.com(?:\?subject=[A-Za-z0-9%]+)?$/.test(value)) return;
  if (allowedExternalLinks.has(value)) return;
  fail(`${location} has a disallowed URL: ${value}`);
}

for (const name of pages) {
  const filePath = path.join(publicDirectory, `${name}.html`);
  if (!fs.existsSync(filePath)) {
    fail(`Missing legal page: ${name}.html`);
    continue;
  }
  const html = fs.readFileSync(filePath, 'utf8');
  const { tags, withoutComments } = parseTags(html);
  const htmlTag = tags.find((tag) => tag.name === 'html');
  if (htmlTag?.attributes.lang !== 'ja') fail(`${name}.html must start in Japanese`);
  const languages = new Set(
    tags.filter((tag) => tag.name === 'section').map((tag) => tag.attributes['data-lang']),
  );
  if (!languages.has('ja') || !languages.has('en')) {
    fail(`${name}.html must contain real Japanese and English sections`);
  }

  const visibleText = withoutComments
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  for (const required of ['HERAC LLC', 'herac.7.app@gmail.com', '2026-09-05']) {
    if (!visibleText.includes(required)) fail(`${name}.html is missing visible ${required}`);
  }
  if (!tags.some((tag) => tag.name === 'a' && classContains(tag.attributes, 'skip-link'))) {
    fail(`${name}.html is missing a real skip link`);
  }

  const scripts = tags.filter((tag) => tag.name === 'script');
  if (scripts.length !== 1 || scripts[0].attributes.src !== './site.js') {
    fail(`${name}.html must load only ./site.js`);
  }
  if (/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(withoutComments)) {
    fail(`${name}.html contains inline script`);
  }

  const urls = tags.flatMap((tag) => ['href', 'src', 'action']
    .filter((attribute) => Object.hasOwn(tag.attributes, attribute))
    .map((attribute) => ({ attribute, value: tag.attributes[attribute] })));
  for (const { attribute, value } of urls) validateUrl(value, `${name}.html ${attribute}`);
  const hrefs = new Set(
    tags.filter((tag) => tag.name === 'a').map((tag) => tag.attributes.href),
  );
  for (const target of legalPageTargets) {
    if (!hrefs.has(`./${target}.html`)) fail(`${name}.html does not link to ${target}.html`);
  }
  if (!hrefs.has('./index.html')) fail(`${name}.html does not link to index.html`);
  if (![...hrefs].some((href) => href?.startsWith('mailto:herac.7.app@gmail.com'))) {
    fail(`${name}.html does not expose the support address`);
  }
}

const siteScriptPath = path.join(publicDirectory, 'site.js');
if (!fs.existsSync(siteScriptPath)) fail('Missing site.js');
else {
  const script = fs.readFileSync(siteScriptPath, 'utf8');
  if (
    /fetch\s*\(|XMLHttpRequest|document\s*\.\s*cookie|\bgtag\b|sendBeacon|WebSocket|EventSource|new\s+Image\b|createElement\s*\(\s*['"]script/i.test(script)
  ) {
    fail('site.js must not send data, create network beacons, or use cookies');
  }
}

try {
  const firebase = JSON.parse(
    fs.readFileSync(path.join(root, 'legal-site/firebase.json'), 'utf8'),
  );
  if (firebase.hosting?.public !== 'public') fail('Firebase public directory must be public');
  if (firebase.hosting?.cleanUrls !== false || firebase.hosting?.trailingSlash !== false) {
    fail('Firebase URL rewriting must stay disabled');
  }
  const catchAll = (firebase.hosting?.headers ?? []).find((entry) => entry?.source === '**');
  const headers = new Map(
    (catchAll?.headers ?? []).map((header) => [header?.key, header?.value]),
  );
  const exactHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  for (const [key, expected] of Object.entries(exactHeaders)) {
    if (headers.get(key) !== expected) fail(`Firebase ${key} must equal ${expected}`);
  }
  const csp = headers.get('Content-Security-Policy');
  const directives = new Map(
    typeof csp === 'string'
      ? csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [directive, ...values] = part.split(/\s+/);
        return [directive, values];
      })
      : [],
  );
  const expectedCsp = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'connect-src': ["'none'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'", 'mailto:'],
  };
  if (directives.size !== Object.keys(expectedCsp).length) {
    fail('Firebase CSP must contain only the reviewed directives');
  }
  for (const [directive, expected] of Object.entries(expectedCsp)) {
    if (JSON.stringify(directives.get(directive)) !== JSON.stringify(expected)) {
      fail(`Firebase CSP ${directive} is incorrect`);
    }
  }
} catch {
  fail('legal-site/firebase.json is missing or invalid');
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Legal site check passed (${pages.length} bilingual pages).\n`);
}
