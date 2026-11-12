package main

import (
	"cmp"
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// Fur Affinity submissions (one meme): the full file of the page. Mature and adult ones need a login:
// the page of a guest has no image, so they fail with 403.

var (
	faHost = regexp.MustCompile(`^(www\.)?furaffinity\.net$`)
	faPath = regexp.MustCompile(`^/(view|full)/(\d+)`)
	// data-tags of the image: u_<artist> c_<category> t_<theme> s_<species> and the keywords
	faGroup = map[string]string{"u_": "artists", "c_": "categories", "t_": "themes", "s_": "species"}
)

var furaffinity = &Source{
	Name:  "furaffinity",
	Match: func(u *url.URL) bool { return faHost.MatchString(u.Hostname()) && faPath.MatchString(u.Path) },
	Fetch: func(ctx context.Context, c *Client, u *url.URL, q ListReq) (*Listing, error) {
		id := faPath.FindStringSubmatch(u.Path)[2]
		source := "https://www.furaffinity.net/view/" + id + "/"
		page, err := c.Text(ctx, source, nil)
		if err != nil {
			return nil, err
		}
		hits := scrape(page, "img#submissionImg", ".submission-title h2", "div[class*='c-contentRating--']", "body#pageid-mature-content-error")
		img := only(hits, "img#submissionImg")
		if len(img) == 0 {
			if len(only(hits, "body#pageid-mature-content-error")) > 0 {
				return nil, &StatusError{Status: 403, URL: source} // needs a login
			}
			return nil, errors.New("furaffinity: no image")
		}
		a := img[0].Attrs
		g := &groups{}
		for _, t := range strings.Fields(a["data-tags"]) {
			if k := faGroup[t[:min(2, len(t))]]; k != "" && len(t) > 2 {
				g.add(k, tagName(t[2:]))
			} else {
				g.add("tags", tagName(t))
			}
		}
		title, rating := first(hits, ".submission-title h2"), strings.ToLower(first(hits, "div[class*='c-contentRating--']"))
		l := &Listing{Source: source}
		media := pickMedia(ctx, c, abs(cmp.Or(a["data-fullview-src"], a["src"]), source), abs(a["data-preview-src"], source), "", q.Limits, nil)
		if media != "" {
			data := g.into(map[string]any{"id": num(id), "title": title, "rating": rating})
			l.Items = []Item{{URL: media, Tags: g.flat(), Data: data, Porn: rating == "mature" || rating == "adult"}}
		}
		return l, nil
	},
}
