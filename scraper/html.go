// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: getImgSrc, tag and format-map helpers (ParseHelper.kt).
// HTML scraping: the selectors in, the matching elements in document order out.
package main

import (
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/andybalholm/cascadia"
	"golang.org/x/net/html"
)

// Hit is one element that matched a selector.
type Hit struct {
	Sel   string // the selector that matched
	Attrs map[string]string
	Text  string // text of the element with its descendants, spaces collapsed
}

var spaces = regexp.MustCompile(`\s+`)

// scrape returns the elements that match any of sels, in document order (an element that matches two selectors comes twice).
func scrape(doc string, sels ...string) []Hit {
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return nil
	}
	ms := make([]cascadia.SelectorGroup, len(sels))
	for i, s := range sels {
		if ms[i], err = cascadia.ParseGroup(s); err != nil {
			panic(err) // the selectors are constants
		}
	}
	var hits []Hit
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			for i, m := range ms {
				if m.Match(n) {
					hits = append(hits, Hit{Sel: sels[i], Attrs: attrs(n), Text: strings.TrimSpace(spaces.ReplaceAllString(text(n), " "))})
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return hits
}

func attrs(n *html.Node) map[string]string {
	a := map[string]string{}
	for _, x := range n.Attr {
		a[x.Key] = x.Val
	}
	return a
}

func text(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		b.WriteString(text(c))
	}
	return b.String()
}

// only returns the hits of one selector.
func only(hits []Hit, sel string) []Hit {
	var out []Hit
	for _, h := range hits {
		if h.Sel == sel {
			out = append(out, h)
		}
	}
	return out
}

// first returns the text of the first hit of sel, or "".
func first(hits []Hit, sel string) string {
	if h := only(hits, sel); len(h) > 0 {
		return h[0].Text
	}
	return ""
}

// abs resolves ref against base; "" when either is not a URL.
func abs(ref, base string) string {
	b, err := url.Parse(base)
	if err != nil {
		return ""
	}
	r, err := b.Parse(ref)
	if err != nil {
		return ""
	}
	return r.String()
}

// imgSrc is the first non-empty image attribute (Hentoid getImgSrc), as an absolute URL.
func imgSrc(a map[string]string, base string) string {
	for _, k := range []string{"data-src", "data-lazy-src", "data-lazysrc", "data-original", "src", "data-cfsrc"} {
		if s := strings.TrimSpace(a[k]); s != "" {
			return abs(s, base)
		}
	}
	return ""
}

// tagName is a tag as in booru tags: lowercase, underscores for spaces.
func tagName(s string) string {
	return spaces.ReplaceAllString(strings.ToLower(strings.TrimSpace(s)), "_")
}

func tagNames(a []string) []string {
	out := make([]string, len(a))
	for i, s := range a {
		out[i] = tagName(s)
	}
	return out
}

// uniq returns the unique values in order, empty ones dropped.
func uniq(a []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range a {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// numbered returns the image URLs of a gallery from the first page dir and the format map {"1":"j,w,h",…} (ImHentai, HentaiFox).
func numbered(dir string, formats map[string]string) []string {
	ext := map[byte]string{'p': "png", 'g': "gif", 'w': "webp"} // anything else is jpg
	keys := make([]string, 0, len(formats))
	for k := range formats {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { a, _ := strconv.Atoi(keys[i]); b, _ := strconv.Atoi(keys[j]); return a < b })
	out := make([]string, len(keys))
	for i, k := range keys {
		e := "jpg"
		if f := formats[k]; f != "" && ext[f[0]] != "" {
			e = ext[f[0]]
		}
		out[i] = dir + k + "." + e
	}
	return out
}

// groups are tag groups by type in the order of their first tag.
type groups struct {
	keys []string
	m    map[string][]string
}

func (g *groups) add(k string, v ...string) {
	if g.m == nil {
		g.m = map[string][]string{}
	}
	if _, ok := g.m[k]; !ok {
		g.keys = append(g.keys, k)
	}
	g.m[k] = append(g.m[k], v...)
}

// flat returns all tags of all groups in order, unique.
func (g *groups) flat() []string {
	var all []string
	for _, k := range g.keys {
		all = append(all, g.m[k]...)
	}
	return uniq(all)
}

// into adds the groups to the data object d.
func (g *groups) into(d map[string]any) map[string]any {
	for k, v := range g.m {
		d[k] = v
	}
	return d
}

var types = map[string]string{"artist": "artists", "group": "groups", "parody": "parodies", "character": "characters", "tag": "tags", "language": "languages", "category": "categories"}

// linkTags makes tags of the links /<type>/<slug>/ (ImHentai, HentaiFox, AsmHentai), grouped by type.
func linkTags(links []Hit) *groups {
	g := &groups{}
	for _, l := range links {
		var parts []string
		for _, p := range strings.Split(strings.SplitN(l.Attrs["href"], "?", 2)[0], "/") {
			if p != "" {
				parts = append(parts, p)
			}
		}
		if len(parts) < 2 {
			continue
		}
		typ, slug := parts[len(parts)-2], parts[len(parts)-1]
		if s, err := url.PathUnescape(slug); err == nil {
			slug = s
		}
		if types[typ] != "" {
			g.add(types[typ], tagName(strings.ReplaceAll(slug, "-", " ")))
		}
	}
	return g
}

// toMap turns a JSON object (raw bytes or a struct) into a map, to add fields to it.
func toMap(v any) map[string]any {
	b, ok := v.([]byte)
	if !ok {
		b, _ = json.Marshal(v)
	}
	m := map[string]any{}
	_ = json.Unmarshal(b, &m)
	return m
}

// str is a nullable title: nil for "".
func str(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// num is the first number in s, or nil.
func num(s string) any {
	if m := digits.FindString(s); m != "" {
		n, _ := strconv.Atoi(m)
		if n != 0 {
			return n
		}
	}
	return nil
}

var digits = regexp.MustCompile(`\d+`)
