package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Rule34 and Gelbooru (Gelbooru 0.2 sites): posts (one meme) and pools (a comic in pool order).
// Their API needs a key, so the post pages are scraped: tags, stats and the "Original image" link.

const gbStep = 15 // posts per listing step of a pool (one page request each)

var (
	gbTypes = []string{"copyright", "character", "artist", "general", "metadata"}
	gbStat  = regexp.MustCompile(`^(Id|Posted|Size|Rating|Score):\s*(.*)$`)
	gbID    = regexp.MustCompile(`[?&]id=(\d+)`)
	gbTag   = regexp.MustCompile(`tags=([^&]+)`)
	gbDate  = regexp.MustCompile(`^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`)
	gbSize  = regexp.MustCompile(`^(\d+)x(\d+)`)
	gbNum   = regexp.MustCompile(`^\d+$`)
	gbPid   = regexp.MustCompile(`pid=(\d+)`)
	gbThumb = "#pool-show a[href*='s=view'], .thumbnail-container a[href*='s=view']" // Rule34, Gelbooru
)

// gbTagSel is the selector of the tag links of one type.
func gbTagSel(typ string) string { return "li.tag-type-" + typ + " a[href*='tags=']" }

// gbPath is the kind (post, pool) and the id of a page link.
func gbPath(u *url.URL) (string, string) {
	q := u.Query()
	if u.Path != "/index.php" || !gbNum.MatchString(q.Get("id")) {
		return "", ""
	}
	switch {
	case q.Get("page") == "post" && q.Get("s") == "view":
		return "post", q.Get("id")
	case q.Get("page") == "pool" && q.Get("s") == "show":
		return "pool", q.Get("id")
	}
	return "", ""
}

// pickMedia (Rule34, Gelbooru, Fur Affinity) is the file to save: the original, a sample only when a photo is over
// the Bot API limit, the mp4 of a webm (Telegram does not play webm); "": over the limit or not importable. The size comes from a HEAD request.
func pickMedia(ctx context.Context, c *Client, orig, sample, mp4 string, lim Limits, h map[string]string) string {
	ext := strings.ToLower(path.Ext(orig))
	if ext == ".webm" && mp4 != "" {
		orig, ext = mp4, ".mp4"
	}
	var limit int64
	photo := false
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp":
		limit, photo = lim.Photo, true
	case ".gif":
		limit = lim.Animation
	case ".mp4", ".webm":
		limit = lim.Video
	default: // swf, …
		return ""
	}
	if photo && sample == "" { // not resized: small enough
		return orig
	}
	if res, err := c.Fetch(ctx, Req{URL: orig, Method: "HEAD", Headers: h}); err != nil || !res.ok() || res.Size <= limit {
		return orig // an unknown size passes
	}
	if photo {
		return sample
	}
	return ""
}

// gbPost scrapes a post page into an item; nil when the post has no importable file.
func gbPost(ctx context.Context, c *Client, base, id string, lim Limits, h map[string]string) (*Item, error) {
	page := base + "?page=post&s=view&id=" + id
	html, err := c.Text(ctx, page, nil)
	var se *StatusError
	if errors.As(err, &se) && se.Status == 404 { // deleted
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sels := []string{"a", "li", "li a[rel=nofollow]", "img#image", "video source"}
	for _, t := range gbTypes {
		sels = append(sels, gbTagSel(t))
	}
	hits := scrape(html, sels...)
	g := &groups{}
	for _, t := range gbTypes {
		for _, a := range only(hits, gbTagSel(t)) {
			if m := gbTag.FindStringSubmatch(a.Attrs["href"]); m != nil {
				name, _ := url.QueryUnescape(m[1])
				g.add(t, name)
			}
		}
	}
	data := map[string]any{"id": num(id)}
	rating := ""
	for _, li := range only(hits, "li") {
		m := gbStat.FindStringSubmatch(li.Text)
		if m == nil {
			continue
		}
		switch k, v := m[1], m[2]; k {
		case "Rating":
			rating = strings.ToLower(v)
			data["rating"] = rating
		case "Score":
			data["score"] = num(v)
		case "Posted":
			data["posted"] = gbDate.FindString(v)
		case "Size":
			if s := gbSize.FindStringSubmatch(v); s != nil {
				data["width"], data["height"] = num(s[1]), num(s[2])
			}
		}
	}
	if a := only(hits, "li a[rel=nofollow]"); len(a) > 0 {
		data["source"] = a[0].Attrs["href"]
	}
	// The links have a cache-buster query (?id) that is not part of the file
	noQuery := func(s string) string { s, _, _ = strings.Cut(abs(s, page), "?"); return s }
	orig, sample, mp4 := "", "", ""
	for _, a := range only(hits, "a") {
		if a.Text == "Original image" {
			orig = noQuery(a.Attrs["href"])
			break
		}
	}
	if s := only(hits, "img#image"); len(s) > 0 {
		if sample = noQuery(s[0].Attrs["src"]); sample == orig {
			sample = ""
		}
	}
	for _, s := range only(hits, "video source") {
		if strings.HasSuffix(s.Attrs["src"], ".mp4") {
			mp4 = noQuery(s.Attrs["src"])
		}
	}
	if orig == "" {
		return nil, nil
	}
	media := pickMedia(ctx, c, orig, sample, mp4, lim, h)
	if media == "" {
		return nil, nil
	}
	return &Item{URL: media, Tags: g.flat(), Data: g.into(data), Porn: rating == "explicit" || rating == "questionable"}, nil
}

// gbPool lists gbStep posts of a pool per step. The cursor is "<pid>.<index>": the pool page (Gelbooru has
// more pages, Rule34 one) and the first post of the step on it.
func gbPool(ctx context.Context, c *Client, base, id string, q ListReq, h map[string]string) (*Listing, error) {
	pid, skip := 0, 0
	if q.Cursor != "" {
		if _, err := fmt.Sscanf(q.Cursor, "%d.%d", &pid, &skip); err != nil {
			return nil, fmt.Errorf("bad cursor %q", q.Cursor)
		}
	}
	html, err := c.Text(ctx, fmt.Sprintf("%s?page=pool&s=show&id=%s&pid=%d", base, id, pid), nil)
	if err != nil {
		return nil, err
	}
	hits := scrape(html, "#pool-show h4", "h3", gbThumb, ".pagination a[href*='pid=']")
	title := ""
	for _, t := range append(only(hits, "#pool-show h4"), only(hits, "h3")...) {
		for _, p := range []string{"Pool: ", "Now Viewing: "} {
			if s, ok := strings.CutPrefix(t.Text, p); ok {
				title = s
			}
		}
	}
	var ids []string
	for _, a := range only(hits, gbThumb) {
		if m := gbID.FindStringSubmatch(a.Attrs["href"]); m != nil {
			ids = append(ids, m[1])
		}
	}
	ids = uniq(ids)
	if len(ids) == 0 {
		return nil, fmt.Errorf("pool %s has no posts", id)
	}
	info := map[string]any{"id": num(id), "name": title}
	l := &Listing{Source: base + "?page=pool&s=show&id=" + id, Title: str(title), Data: info}
	end := min(skip+gbStep, len(ids))
	for _, post := range ids[min(skip, end):end] {
		it, err := gbPost(ctx, c, base, post, q.Limits, h)
		if err != nil {
			return nil, err
		}
		if it != nil {
			data := toMap(it.Data)
			data["pool"] = info
			it.Data = data
			l.Items = append(l.Items, *it)
		}
	}
	if end < len(ids) {
		l.Next = fmt.Sprintf("%d.%d", pid, end)
		return l, nil
	}
	next := 0 // the next page: the smallest pid after this one
	for _, a := range only(hits, ".pagination a[href*='pid=']") {
		if m := gbPid.FindStringSubmatch(a.Attrs["href"]); m != nil {
			if n, _ := strconv.Atoi(m[1]); n > pid && (next == 0 || n < next) {
				next = n
			}
		}
	}
	if next > 0 {
		l.Next = fmt.Sprintf("%d.0", next)
	}
	return l, nil
}

// gbSource makes the source of a site; host is without www.
func gbSource(name, host string, headers map[string]string) *Source {
	hostRe := regexp.MustCompile(`^(www\.)?` + regexp.QuoteMeta(host) + `$`)
	base := "https://" + host + "/index.php"
	return &Source{
		Name:    name,
		Headers: headers,
		Match: func(u *url.URL) bool {
			kind, _ := gbPath(u)
			return hostRe.MatchString(u.Hostname()) && kind != ""
		},
		Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
			kind, id := gbPath(u)
			if kind == "pool" {
				return gbPool(ctx, c, base, id, q, headers)
			}
			l := &Listing{Source: base + "?page=post&s=view&id=" + id}
			it, err := gbPost(ctx, c, base, id, q.Limits, headers)
			if it != nil {
				l.Items = []Item{*it}
			}
			return l, err
		},
	}
}

var rule34 = gbSource("rule34", "rule34.xxx", nil)
var gelbooru = gbSource("gelbooru", "gelbooru.com", map[string]string{"Referer": "https://gelbooru.com/"}) // the images are hotlink protected
