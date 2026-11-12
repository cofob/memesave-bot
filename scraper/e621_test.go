package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

const e6S = "https://static1.e621.net"

func e6Post(id int, extra string) string {
	p := map[string]any{}
	_ = json.Unmarshal([]byte(fmt.Sprintf(`{"id":%[1]d,"rating":"s","file":{"ext":"jpg","size":1000,"url":"%[2]s/data/%[1]d.jpg"},"sample":{"url":"%[2]s/sample/%[1]d.jpg","alternates":{}},
		"tags":{"general":["tag%[1]d"],"artist":["bob"],"species":["wolf"],"invalid":["bad"]},"pools":[]}`, id, e6S)), &p)
	_ = json.Unmarshal([]byte(cmpOr(extra, "{}")), &p)
	b, _ := json.Marshal(p)
	return string(b)
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func e6Media(t *testing.T, raw string) string {
	var p e621Post
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	return mediaURL(&p, defaultLimits)
}

func TestE621Media(t *testing.T) {
	eq(t, e6Media(t, e6Post(1, "")), e6S+"/data/1.jpg")
	eq(t, e6Media(t, e6Post(2, fmt.Sprintf(`{"file":{"ext":"png","size":%d,"url":"%s/data/2.png"}}`, 20<<20, e6S))), e6S+"/sample/2.jpg") // too big for a photo
	eq(t, e6Media(t, e6Post(3, `{"file":{"ext":"jpg","size":1000,"url":null},"sample":{"url":null}}`)), "")                               // hidden from guests
	eq(t, e6Media(t, e6Post(4, fmt.Sprintf(`{"file":{"ext":"webm","size":%d,"url":"%[2]s/4.webm"},"sample":{"url":null,"alternates":{"samples":{"720p":{"url":"%[2]s/4_720p.mp4","size":%d}}}}}`, 99<<20, e6S, 5<<20))), e6S+"/4_720p.mp4")
	eq(t, e6Media(t, e6Post(9, `{"file":{"ext":"mp4","size":20000000,"url":"https://x/9.mp4"},"sample":{"url":null,"alternates":{"samples":{"720p":{"url":"https://x/9_720p.mp4","size":5}}}}}`)), "https://x/9.mp4")                                                             // the original first
	eq(t, e6Media(t, e6Post(10, `{"file":{"ext":"webm","size":1000,"url":"https://x/10.webm"},"sample":{"url":null,"alternates":{"variants":{"mp4":{"url":"https://x/10.mp4","size":2000}},"samples":{"720p":{"url":"https://x/10_720p.mp4","size":5}}}}}`)), "https://x/10.mp4") // a webm: the mp4 of the original size
	eq(t, e6Media(t, e6Post(11, fmt.Sprintf(`{"file":{"ext":"mp4","size":%d,"url":"https://x/11.mp4"},"sample":{"url":null,"alternates":{"samples":{"720p":{"url":"https://x/11_720p.mp4","size":5}}}}}`, 60<<20))), "https://x/11_720p.mp4")                                     // over 50 MB: 720p
	eq(t, e6Media(t, e6Post(5, `{"file":{"ext":"webm","size":1000,"url":"https://x/5.webm"}}`)), "")                                                                                                                                                                              // webm without an mp4
	eq(t, e6Media(t, e6Post(6, `{"file":{"ext":"mp4","size":1000,"url":"https://x/6.mp4"}}`)), "https://x/6.mp4")
	eq(t, e6Media(t, e6Post(7, `{"file":{"ext":"swf","size":1000,"url":"https://x/7.swf"}}`)), "")
	eq(t, e6Media(t, e6Post(8, fmt.Sprintf(`{"file":{"ext":"gif","size":%d,"url":"https://x/8.gif"}}`, 20<<20))), "https://x/8.gif") // GIFs may be up to 50 MB
}

func TestE621Post(t *testing.T) {
	p := e6Post(11, `{"rating":"e"}`)
	p = strings.Replace(p, `"tags":{"artist":["bob"],"general":["tag11"],"invalid":["bad"],"species":["wolf"]}`, `"tags":{"artist":["bob"],"character":["Fox"],"general":["tag"],"invalid":["bad"],"lore":["l"],"meta":["m"],"species":["wolf"],"copyright":["c"]}`, 1)
	c, calls := site(map[string]any{"https://e621.net/posts/11.json": J(`{"post":` + p + `}`)})
	u := "https://e621.net/posts/11"
	l, err := listErr(c, e621, u, "")
	if err != nil {
		t.Fatal(err)
	}
	eq(t, (*calls)[0].Headers["User-Agent"], "memesave/1.0 (e621 importer)")
	eq(t, (*calls)[0].Headers["Authorization"], "")
	eq(t, l.Source, u)
	eq(t, l.Title, (*string)(nil))
	eq(t, len(l.Items), 1)
	it := l.Items[0]
	eq(t, it.URL, e6S+"/data/11.jpg")
	eq(t, it.Tags, []string{"bob", "Fox", "tag", "l", "m", "wolf", "c"})
	eq(t, it.Porn, true)
	has(t, it.Data, p)

	pu, _ := url.Parse(u)
	l2, _ := e621.Fetch(t.Context(), c, pu, ListReq{Auth: "Basic xyz", Limits: defaultLimits})
	eq(t, (*calls)[1].Headers["Authorization"], "Basic xyz")
	eq(t, len(l2.Items), 1)
}

func TestE621Pool(t *testing.T) {
	var posts []string
	for _, id := range []int{3, 2, 1} {
		posts = append(posts, e6Post(id, `{"pools":[9]}`))
	}
	c, _ := site(map[string]any{
		"https://e621.net/pools/9.json":                              J(`{"id":9,"name":"My_Pool","category":"series","post_ids":[2,3,1]}`),
		"https://e621.net/posts.json?limit=320&page=1&tags=pool%3A9": J(`{"posts":[` + strings.Join(posts, ",") + `]}`),
	})
	l := listing(t, c, e621, "https://e621.net/pools/9", "")
	eq(t, title(l), "My Pool")
	eq(t, l.Source, "https://e621.net/pools/9")
	eq(t, urls(l.Items), []string{e6S + "/data/2.jpg", e6S + "/data/3.jpg", e6S + "/data/1.jpg"})
	has(t, l.Items[0].Data, `{"id":2,"pool":{"id":9,"name":"My_Pool","category":"series"}}`)
	if _, ok := l.Items[0].Data.(map[string]any)["pool"].(map[string]any)["post_ids"]; ok {
		t.Fatal("post_ids in the pool data")
	}
}
