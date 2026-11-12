// Ported from Hentoid (codeberg.org/VioletKnight/Hentoid), Apache-2.0: AllPornComicContent.kt, AllPornComicParser.kt.
package main

import (
	"context"
	"encoding/json"
	"net/url"
	"regexp"
	"slices"
	"strings"
)

const (
	apcSite            = "https://allporncomic.com"
	apcChaptersPerStep = 19 // + the series page in the first step
)

var (
	apcPath   = regexp.MustCompile(`^/(porncomic|manga)/[^/]+(/[^/]+)?/?$`)
	apcTerm   = regexp.MustCompile(`allporncomic\.com/([^/]+)/`)
	apcSuffix = regexp.MustCompile(`\s*[-|]\s*AllPornComic$`)
	apcStatus = regexp.MustCompile(`(?i)ongoing|completed`)
	// Term links of the series page by the first path segment: the group in data
	apcGroups = map[string]string{"porncomicartist": "artists", "porncomic-artist": "artists", "porncomic-category": "tags", "porncomic-genre": "tags", "characters": "characters", "series": "series"}
)

// apcClean drops the site from a title: "… Porn Comic | AllPornComic".
func apcClean(title string) string {
	return strings.TrimSpace(strings.TrimSuffix(apcSuffix.ReplaceAllString(title, ""), " Porn Comic"))
}

// apcChapter returns the title and the images of one chapter page, in order.
func apcChapter(ctx context.Context, c *Client, u string) (string, []Item, error) {
	page, err := c.Text(ctx, u, nil)
	if err != nil {
		return "", nil, err
	}
	hits := scrape(page, "head title", "[class^=page-break] img")
	var srcs []string
	for _, i := range only(hits, "[class^=page-break] img") {
		srcs = append(srcs, imgSrc(i.Attrs, u))
	}
	var items []Item
	for _, s := range uniq(srcs) {
		items = append(items, Item{URL: s})
	}
	return apcClean(first(hits, "head title")), items, nil
}

// apcStep lists up to apcChaptersPerStep chapters of urls; the cursor holds the rest. meta is of the first step.
func apcStep(ctx context.Context, c *Client, source string, urls []string, meta *Listing) (*Listing, error) {
	l := &Listing{Source: source}
	if meta != nil {
		l.Title, l.Tags, l.Data = meta.Title, meta.Tags, meta.Data
	}
	for _, u := range urls[:min(len(urls), apcChaptersPerStep)] {
		title, items, err := apcChapter(ctx, c, u)
		if err != nil {
			return nil, err
		}
		l.Items = append(l.Items, items...)
		if l.Title == nil {
			l.Title = &title
		}
	}
	if meta == nil {
		l.Data = map[string]any{"title": l.Title}
	}
	if rest := urls[min(len(urls), apcChaptersPerStep):]; len(rest) > 0 {
		b, _ := json.Marshal(rest)
		l.Next = string(b)
	}
	return l, nil
}

var allporncomic = &Source{
	Name: "allporncomic",
	Match: func(u *url.URL) bool {
		return strings.HasSuffix(u.Hostname(), "allporncomic.com") && apcPath.MatchString(u.Path)
	},
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/") // [porncomic, series, chapter?]
		series := apcSite + "/porncomic/" + parts[1] + "/"     // the site serves series under /porncomic/ only
		if q.Cursor != "" {                                    // the rest of the chapters
			var rest []string
			if err := json.Unmarshal([]byte(q.Cursor), &rest); err != nil {
				return nil, err
			}
			return apcStep(ctx, c, series, rest, nil)
		}
		if len(parts) > 2 { // a chapter link: this chapter only
			ch := series + parts[2] + "/"
			return apcStep(ctx, c, ch, []string{ch}, nil)
		}
		page, err := c.Text(ctx, series, nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "head title", ".post-content a", ".summary-content", "li.wp-manga-chapter > a", "li.wp-manga-chapter .chapter-release-date i")
		// The chapter list can hold fake chapters (random names, a "new" label instead of the date): when there are dated ones, only they count
		type chapter struct {
			href  string
			dated bool
		}
		var chapters []chapter
		for _, h := range hits {
			if h.Sel == "li.wp-manga-chapter > a" {
				chapters = append(chapters, chapter{href: abs(h.Attrs["href"], apcSite)})
			} else if strings.HasSuffix(h.Sel, " i") && len(chapters) > 0 {
				chapters[len(chapters)-1].dated = true
			}
		}
		if slices.ContainsFunc(chapters, func(c chapter) bool { return c.dated }) {
			chapters = slices.DeleteFunc(chapters, func(c chapter) bool { return !c.dated })
		}
		var urls []string
		for _, ch := range chapters {
			urls = append(urls, ch.href)
		}
		urls = uniq(urls)
		slices.Reverse(urls) // the list is newest first

		g := &groups{}
		for _, a := range only(hits, ".post-content a") {
			if m := apcTerm.FindStringSubmatch(a.Attrs["href"]); m != nil && apcGroups[m[1]] != "" && a.Text != "" {
				g.add(apcGroups[m[1]], a.Text)
			}
		}
		var status any
		var tags []string
		for _, h := range only(hits, ".summary-content") {
			if s := apcStatus.FindString(h.Text); s != "" {
				status = strings.ToLower(s)
				break
			}
		}
		tags = tagNames(g.flat())
		if status != nil {
			tags = append(tags, status.(string))
		}
		title := apcClean(first(hits, "head title"))
		meta := &Listing{Title: &title, Tags: uniq(tags), Data: g.into(map[string]any{"title": title, "status": status, "chapters": len(urls)})}
		return apcStep(ctx, c, series, urls, meta)
	},
}
