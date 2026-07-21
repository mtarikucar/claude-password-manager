/**
 * URL / domain helpers used to decide whether a saved credential belongs to the
 * page the browser is on. Deliberately simple (last-two-labels base domain) —
 * good enough to match a login to a site without a public-suffix list.
 */

/** Hostname of a URL, lowercased and without a leading "www.". Null if unusable. */
export function hostFromUrl(url: string): string | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Bare "example.com" or "example.com/path" without a scheme.
    const m = raw.toLowerCase().match(/^([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
    return m ? m[1].replace(/^www\./, "") : null;
  }
}

/** Naive registrable domain: the last two labels (e.g. a.b.tiktok.com -> tiktok.com). */
export function baseDomain(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Does a stored entry URL belong to the same site as the page URL? */
export function domainMatches(entryUrl: string | undefined, pageUrl: string): boolean {
  if (!entryUrl) return false;
  const e = hostFromUrl(entryUrl);
  const p = hostFromUrl(pageUrl);
  if (!e || !p) return false;
  return e === p || baseDomain(e) === baseDomain(p);
}
