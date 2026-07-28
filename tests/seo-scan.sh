#!/usr/bin/env bash
# tests/seo-scan.sh — guards the entity wiring this domain REFERENCES.
#
# WHY THIS EXISTS
# ---------------
# workwithclayton.com is the property that already ranks #1 for founder-name
# queries ("Clayton Camera <qualifier>"), which makes it the most expensive
# place in the network for a silent regression.
#
# It does NOT own the person entity. It references one canonical id:
#
#     https://claytoncamera.com/#person
#
# defined on claytoncamera.com. Minting a second id here, or dropping the
# reference in a redesign, splits one person into two weakly-evidenced entities
# and throws away the strongest ranking signal the network has. None of that
# errors; the page renders identically. Hence these assertions.
#
# Until 2026-07-28 this repo was covered by no test at all and the runbook said
# "hand-check it when editing" — which is not a control.
#
# Static-only: no network, no browser. Safe to run anywhere.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAILED=0
fail() { echo "  ❌ $1"; FAILED=1; }
ok()   { echo "  ✅ $1"; }

PERSON_ID="https://claytoncamera.com/#person"
DOMAIN="https://workwithclayton.com"

# Public pages, as sitemap paths. Add new pages here AND to sitemap.xml.
PAGES=( "/" "/intake/" )

# ── 1. domain plumbing ──────────────────────────────────────────────────
echo "-- domain plumbing --"
[ -f CNAME ] && grep -q "^workwithclayton.com" CNAME \
  && ok "CNAME points at workwithclayton.com" \
  || fail "CNAME missing or wrong — GitHub Pages drops the custom domain"

if [ ! -f robots.txt ]; then
  fail "robots.txt missing"
elif ! grep -q "^Sitemap: ${DOMAIN}/sitemap.xml" robots.txt; then
  fail "robots.txt does not advertise ${DOMAIN}/sitemap.xml"
else
  ok "robots.txt advertises the sitemap"
fi

[ -f sitemap.xml ] && ok "sitemap.xml exists" \
  || fail "sitemap.xml missing — robots.txt points at a 404"

# One Google verification token per ACCOUNT, shared by all three properties.
# Deleting it un-verifies this property in Search Console and silently cuts off
# indexing data.
ls google*.html >/dev/null 2>&1 \
  && ok "Search Console verification file present" \
  || fail "google*.html verification file is GONE — this un-verifies Search Console"

# ── 2. sitemap ↔ filesystem, both directions ────────────────────────────
echo "-- sitemap coverage --"
for p in "${PAGES[@]}"; do
  grep -q "<loc>${DOMAIN}${p}</loc>" sitemap.xml 2>/dev/null \
    && ok "sitemap lists ${p}" || fail "sitemap is MISSING ${p}"
  f=".${p}index.html"
  [ -f "$f" ] && ok "page exists on disk: ${p}" \
    || fail "sitemap lists ${p} but ${f} does not exist"
done

while IFS= read -r f; do
  path="/${f#./}"; path="${path%index.html}"
  declared=0
  for p in "${PAGES[@]}"; do [ "$p" = "$path" ] && declared=1; done
  [ "$declared" = 1 ] || fail "undeclared page on disk: ${path} (add to PAGES + sitemap.xml)"
done < <(find . -name index.html -not -path "./.git/*")

# ── 3. per-page canonicals ──────────────────────────────────────────────
echo "-- canonicals --"
for p in "${PAGES[@]}"; do
  f=".${p}index.html"
  [ -f "$f" ] || continue
  grep -q "<link rel=\"canonical\" href=\"${DOMAIN}${p}\">" "$f" \
    && ok "self-canonical: ${p}" || fail "canonical missing/wrong on ${p}"
done

# ── 4. the entity rules ─────────────────────────────────────────────────
# Parsed, not grepped: a page that ever *writes about* schema would trip a
# text search on a property name.
echo "-- entity wiring --"
python3 - <<'PY' || FAILED=1
import json, re, sys, pathlib

PERSON_ID = "https://claytoncamera.com/#person"
# A Person node carrying any of these DEFINES the entity. The definition lives
# on claytoncamera.com; this repo may only reference it.
DEFINING = {"givenName", "familyName", "disambiguatingDescription", "image",
            "address", "knowsAbout"}

def nodes(payload):
    out = []
    if isinstance(payload, list):
        for i in payload:
            out.extend(nodes(i))
    elif isinstance(payload, dict):
        out.append(payload)
        for v in payload.values():
            out.extend(nodes(v))
    return out

bad, refs = 0, 0
for f in sorted(pathlib.Path('.').rglob('*.html')):
    if '.git' in f.parts:
        continue
    html = f.read_text(encoding='utf-8', errors='replace')
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            payload = json.loads(block)
        except Exception as e:
            print(f"  ❌ JSON-LD in {f} does not parse: {e}")
            bad = 1
            continue
        for n in nodes(payload):
            types = n.get("@type")
            types = types if isinstance(types, list) else [types]
            nid = str(n.get("@id", ""))
            if "Person" not in types and not nid.endswith("#person"):
                continue
            refs += 1
            if nid != PERSON_ID:
                print(f"  ❌ {f}: non-canonical Person @id {nid!r} — splits the entity")
                bad = 1
            leaked = DEFINING & set(n)
            if leaked:
                print(f"  ❌ {f}: Person node REDEFINES the entity via {sorted(leaked)}; "
                      f"reference it only")
                bad = 1

if not refs:
    print("  ❌ no Person reference anywhere — this domain has fallen out of the entity")
    bad = 1
elif not bad:
    print(f"  ✅ all JSON-LD parses; {refs} Person references, all canonical, none redefining")
sys.exit(bad)
PY

# ── 5. crawlers follow anchors, not only schema ─────────────────────────
echo "-- rendered links --"
grep -q 'href="https://claytoncamera.com/"' index.html \
  && ok "homepage links the entity hub" \
  || fail "homepage no longer links claytoncamera.com — schema alone is a weaker claim"
grep -q '>Clayton Camera<' index.html \
  && ok "exact-match anchor text present" \
  || fail "exact-match anchor text 'Clayton Camera' is gone"

# The byline on /intake/ said the name but pointed at loopholemaxing.com until
# 2026-07-28 — exact-match anchor text spent on the wrong URL.
if grep -q 'Built by <a href="https://claytoncamera.com/" rel="author"' intake/index.html; then
  ok "/intake/ byline points at the entity with rel=author"
else
  fail "/intake/ byline no longer points at claytoncamera.com with rel=author"
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "ALL CHECKS PASSED"
else
  echo "SEO SCAN FAILED"
fi
exit "$FAILED"
