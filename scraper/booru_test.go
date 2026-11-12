package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// gbHTML is a Gelbooru 0.2 post page: tags, stats, the original link and the image (a sample when resized).
func gbHTML(rating, orig, img string) string {
	return `<ul id="tag-sidebar"><li><h6>Artist</h6></li><li class="tag-type-artist tag"><a href="index.php?page=wiki&s=list&search=bob">?</a>
		<a href="index.php?page=post&amp;s=list&amp;tags=bob">bob</a><span class="tag-count">9</span></li>
		<li class="tag-type-character tag"><a href="index.php?page=wiki">?</a><a href="index.php?page=post&amp;s=list&amp;tags=nier%3A_automata">nier: automata</a></li>
		<li class="tag-type-general tag"><a href="index.php?page=post&amp;s=list&amp;tags=white_hair">white hair</a></li></ul>
		<div id="stats"><ul><li>Id: 7</li><li>Posted: 2021-08-17 14:43:49<br /> by <a href="x">Hank</a></li><li>Size: 1800x2099</li>
		<li>Source: <a href="https://www.pixiv.net/artworks/1" rel="nofollow">www.pixiv.net/artworks/1</a></li><li>Rating: ` + rating + `</li>
		<li>Score: <span id="psc7">365</span> (vote <a href="#">up</a>)</li></ul></div>
		<ul><li><a href="` + orig + `" onclick="return false;">
			Original image
		</a></li></ul>` + img
}

const (
	r34  = "https://rule34.xxx/index.php?page=post&s=view&id=%d"
	r34W = "https://wimg.rule34.xxx"
)

func TestGbMatch(t *testing.T) {
	for raw, want := range map[string]*Source{
		"https://rule34.xxx/index.php?page=post&s=view&id=5000000":        rule34,
		"https://www.rule34.xxx/index.php?page=post&s=view&id=5&tags=x":   rule34,
		"https://rule34.xxx/index.php?page=pool&s=show&id=59591":          rule34,
		"https://gelbooru.com/index.php?page=post&s=view&id=9000000":      gelbooru,
		"https://www.gelbooru.com/index.php?page=pool&s=show&id=74265":    gelbooru,
		"https://rule34.xxx/index.php?page=post&s=list&tags=x":            nil,
		"https://rule34.xxx/index.php?page=post&s=view&id=abc":            nil,
		"https://rule34.xxx/index.php?page=pool&s=list":                   nil,
		"https://gelbooru.com/":                                           nil,
		"https://danbooru.donmai.us/posts/9000000":                        danbooru,
		"https://safebooru.donmai.us/pools/5668?x=1":                      danbooru,
		"https://danbooru.donmai.us/posts":                                nil,
		"https://www.furaffinity.net/view/67018218/":                      furaffinity,
		"https://furaffinity.net/full/67018218":                           furaffinity,
		"https://www.furaffinity.net/gallery/x/":                          nil,
		"https://www.pixiv.net/en/artworks/78795182":                      pixiv,
		"https://pixiv.net/artworks/1":                                    pixiv,
		"https://www.pixiv.net/member_illust.php?mode=medium&illust_id=3": pixiv,
		"https://www.pixiv.net/users/1":                                   nil,
	} {
		u, _ := url.Parse(raw)
		if got := sourceOf(u); got != want {
			t.Errorf("%s: got %v", raw, got)
		}
	}
}

func TestRule34Post(t *testing.T) {
	img := `<img id="image" src="` + r34W + `//samples/1/sample_a.jpg?7">`
	c, calls := site(map[string]any{fmt.Sprintf(r34, 7): gbHTML("Questionable", r34W+"//images/1/a.png?7", img)})
	l := listing(t, c, rule34, fmt.Sprintf(r34, 7)+"&tags=x", "")
	eq(t, l.Source, fmt.Sprintf(r34, 7))
	eq(t, urls(l.Items), []string{r34W + "//images/1/a.png"}) // HEAD answers 404: the size is unknown, the original passes
	it := l.Items[0]
	eq(t, it.Tags, []string{"nier:_automata", "bob", "white_hair"})
	eq(t, it.Porn, true)
	has(t, it.Data, `{"id":7,"rating":"questionable","score":365,"width":1800,"height":2099,"posted":"2021-08-17 14:43:49","source":"https://www.pixiv.net/artworks/1",
		"artist":["bob"],"character":["nier:_automata"],"general":["white_hair"]}`)
	eq(t, (*calls)[0].URL, fmt.Sprintf(r34, 7))
	eq(t, (*calls)[1].Method, "HEAD") // a resized image: the size of the original is checked

	// A photo over the limit: the sample
	head := func(size int64) map[string]any {
		return map[string]any{fmt.Sprintf(r34, 7): gbHTML("Safe", r34W+"//images/1/a.png?7", img),
			r34W + "//images/1/a.png": func(q Req) any { return &Resp{Status: 200, Size: size} }}
	}
	c, _ = site(head(20 << 20))
	l = listing(t, c, rule34, fmt.Sprintf(r34, 7), "")
	eq(t, urls(l.Items), []string{r34W + "//samples/1/sample_a.jpg"})
	eq(t, l.Items[0].Porn, false)
	c, _ = site(head(5 << 20))
	eq(t, urls(listing(t, c, rule34, fmt.Sprintf(r34, 7), "").Items), []string{r34W + "//images/1/a.png"})

	// Not resized: no request for the size. A video: the size limit, no sample. A deleted post (404): nothing.
	c, calls = site(map[string]any{fmt.Sprintf(r34, 7): gbHTML("Explicit", r34W+"//images/1/a.jpg?7", `<img id="image" src="`+r34W+`//images/1/a.jpg?7">`)})
	eq(t, len(listing(t, c, rule34, fmt.Sprintf(r34, 7), "").Items), 1)
	eq(t, len(*calls), 1)
	vid := "https://ws-cdn-video.rule34.xxx//images/1/v.mp4"
	for size, want := range map[int64]int{40 << 20: 1, 60 << 20: 0} {
		c, _ = site(map[string]any{fmt.Sprintf(r34, 7): gbHTML("Explicit", vid+"?7", ""), vid: func(Req) any { return &Resp{Status: 200, Size: size} }})
		eq(t, len(listing(t, c, rule34, fmt.Sprintf(r34, 7), "").Items), want)
	}
	c, _ = site(nil)
	eq(t, len(listing(t, c, rule34, fmt.Sprintf(r34, 7), "").Items), 0)
	c, _ = site(map[string]any{fmt.Sprintf(r34, 7): gbHTML("Safe", r34W+"//images/1/a.swf", "")})
	eq(t, len(listing(t, c, rule34, fmt.Sprintf(r34, 7), "").Items), 0)
}

func TestGelbooruVideo(t *testing.T) {
	gel := "https://img4.gelbooru.com/images/f0/d3/v"
	page := gbHTML("Explicit", gel+".webm", `<video><source src="`+gel+`.mp4" type="video/mp4" /><source src="`+gel+`.webm" type="video/webm" /></video>`)
	c, _ := site(map[string]any{"https://gelbooru.com/index.php?page=post&s=view&id=7": page, gel + ".mp4": func(Req) any { return &Resp{Status: 200, Size: 1 << 20} }})
	l := listing(t, c, gelbooru, "https://gelbooru.com/index.php?page=post&s=view&id=7", "")
	eq(t, urls(l.Items), []string{gel + ".mp4"}) // the mp4 of a webm
	eq(t, gelbooru.Headers["Referer"], "https://gelbooru.com/")
	c, _ = site(map[string]any{"https://gelbooru.com/index.php?page=post&s=view&id=7": page, gel + ".mp4": func(Req) any { return &Resp{Status: 200, Size: 99 << 20} }})
	eq(t, len(listing(t, c, gelbooru, "https://gelbooru.com/index.php?page=post&s=view&id=7", "").Items), 0)
}

func TestRule34Pool(t *testing.T) {
	routes := map[string]any{}
	var thumbs strings.Builder
	for id := 1; id <= 17; id++ {
		fmt.Fprintf(&thumbs, `<span class="thumb"><a href="index.php?page=post&s=view&id=%d&amp;pool_id=9">x</a></span>`, id)
		routes[fmt.Sprintf(r34, id)] = gbHTML("Safe", fmt.Sprintf("%s//images/1/%d.jpg?1", r34W, id), "")
	}
	routes["https://rule34.xxx/index.php?page=pool&s=show&id=9&pid=0"] = `<div id="pool-show"><h4>Pool: My Pool</h4>` + thumbs.String() + `</div>`
	c, _ := site(routes)
	l := listing(t, c, rule34, "https://rule34.xxx/index.php?page=pool&s=show&id=9", "")
	eq(t, l.Source, "https://rule34.xxx/index.php?page=pool&s=show&id=9")
	eq(t, title(l), "My Pool")
	eq(t, len(l.Items), 15)
	eq(t, l.Items[0].URL, r34W+"//images/1/1.jpg")
	eq(t, l.Next, "0.15")
	has(t, l.Items[14].Data, `{"id":15,"pool":{"id":9,"name":"My Pool"}}`)
	l = listing(t, c, rule34, "https://rule34.xxx/index.php?page=pool&s=show&id=9", "0.15")
	eq(t, urls(l.Items), []string{r34W + "//images/1/16.jpg", r34W + "//images/1/17.jpg"})
	eq(t, l.Next, "")
	if _, err := listErr(c, rule34, "https://rule34.xxx/index.php?page=pool&s=show&id=9", "x"); err == nil {
		t.Fatal("bad cursor")
	}
}

func TestGelbooruPoolPages(t *testing.T) {
	g := "https://gelbooru.com/index.php?page=%s&s=%s&id=%d"
	pool := func(pid int, ids ...int) string {
		var b strings.Builder
		b.WriteString(`<h3>Now Viewing: Pages</h3><div class="thumbnail-container">`)
		for _, id := range ids {
			fmt.Fprintf(&b, `<span><a href="index.php?page=post&amp;s=view&amp;id=%d"><img class="thumbnail-preview"></a></span>`, id)
		}
		return b.String() + `</div><div id="paginator"><div class="pagination"> <b>1</b> <a href="?page=pool&amp;s=show&amp;id=9&amp;pid=2">2</a></div></div>`
	}
	routes := map[string]any{
		"https://gelbooru.com/index.php?page=pool&s=show&id=9&pid=0": pool(0, 1, 2),
		"https://gelbooru.com/index.php?page=pool&s=show&id=9&pid=2": strings.Replace(pool(2, 3), `pid=2">2`, `pid=0">1`, 1),
	}
	for id := 1; id <= 3; id++ {
		routes[fmt.Sprintf(g, "post", "view", id)] = gbHTML("General", fmt.Sprintf("https://img4.gelbooru.com/images/%d.jpg", id), "")
	}
	c, _ := site(routes)
	l := listing(t, c, gelbooru, "https://gelbooru.com/index.php?page=pool&s=show&id=9", "")
	eq(t, title(l), "Pages")
	eq(t, len(l.Items), 2)
	eq(t, l.Next, "2.0") // the next pool page
	l = listing(t, c, gelbooru, "https://gelbooru.com/index.php?page=pool&s=show&id=9", l.Next)
	eq(t, urls(l.Items), []string{"https://img4.gelbooru.com/images/3.jpg"})
	eq(t, l.Next, "")
}

func dbPost(id int, extra string) string {
	p := map[string]any{}
	_ = json.Unmarshal([]byte(fmt.Sprintf(`{"id":%[1]d,"rating":"g","file_ext":"jpg","file_size":1000,"file_url":"https://cdn.donmai.us/original/%[1]d.jpg",
		"large_file_url":"https://cdn.donmai.us/sample/%[1]d.jpg","media_asset":{"variants":[]},"tag_string_artist":"bob","tag_string_copyright":"","tag_string_character":"fox",
		"tag_string_general":"tag%[1]d solo","tag_string_meta":"highres"}`, id)), &p)
	_ = json.Unmarshal([]byte(cmpOr(extra, "{}")), &p)
	b, _ := json.Marshal(p)
	return string(b)
}

func dbMedia(t *testing.T, raw string) string {
	var p danbooruPost
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatal(err)
	}
	return danbooruMedia(&p, defaultLimits)
}

func TestDanbooruMedia(t *testing.T) {
	cdn := "https://cdn.donmai.us"
	eq(t, dbMedia(t, dbPost(1, "")), cdn+"/original/1.jpg")
	eq(t, dbMedia(t, dbPost(2, `{"file_size":20000000}`)), cdn+"/sample/2.jpg")                                                                                     // a photo over 10 MB: the sample
	eq(t, dbMedia(t, dbPost(3, `{"file_size":20000000,"large_file_url":"`+cdn+`/original/3.jpg"}`)), "")                                                            // no sample
	eq(t, dbMedia(t, dbPost(4, `{"file_url":""}`)), "")                                                                                                             // hidden from guests
	eq(t, dbMedia(t, dbPost(5, `{"file_ext":"zip"}`)), "")                                                                                                          // ugoira
	eq(t, dbMedia(t, dbPost(6, `{"file_ext":"gif","file_size":20000000}`)), cdn+"/original/6.jpg")                                                                  // a GIF may be up to 50 MB (the file is named .jpg here)
	eq(t, dbMedia(t, dbPost(7, `{"file_ext":"mp4","file_size":60000000}`)), "")                                                                                     // a video over 50 MB
	eq(t, dbMedia(t, dbPost(8, `{"file_ext":"webm","file_size":1000,"media_asset":{"variants":[{"file_ext":"mp4","url":"https://x/8.mp4"}]}}`)), "https://x/8.mp4") // webm as mp4
	eq(t, dbMedia(t, dbPost(9, `{"file_ext":"webm","file_size":1000}`)), cdn+"/original/9.jpg")
}

func TestDanbooru(t *testing.T) {
	p := dbPost(11, `{"rating":"q"}`)
	c, _ := site(map[string]any{"https://danbooru.donmai.us/posts/11.json": J(p)})
	l := listing(t, c, danbooru, "https://danbooru.donmai.us/posts/11", "")
	eq(t, l.Source, "https://danbooru.donmai.us/posts/11")
	eq(t, len(l.Items), 1)
	it := l.Items[0]
	eq(t, it.URL, "https://cdn.donmai.us/original/11.jpg")
	eq(t, it.Tags, []string{"bob", "fox", "tag11", "solo", "highres"})
	eq(t, it.Porn, true)
	has(t, it.Data, p)
	eq(t, danbooru.Headers["User-Agent"], "memesave/1.0 (danbooru importer)")

	// A pool: pool order, hidden posts left out, the pool in the data of every post
	var posts []string
	for _, id := range []int{3, 2, 1} {
		posts = append(posts, dbPost(id, ""))
	}
	posts = append(posts, dbPost(4, `{"file_url":""}`))
	c, _ = site(map[string]any{
		"https://danbooru.donmai.us/pools/9.json":                              J(`{"id":9,"name":"My_Pool","category":"series","post_ids":[2,4,3,1]}`),
		"https://danbooru.donmai.us/posts.json?limit=200&page=1&tags=pool%3A9": J(`[` + strings.Join(posts, ",") + `]`),
	})
	l = listing(t, c, danbooru, "https://www.danbooru.donmai.us/pools/9", "")
	eq(t, title(l), "My Pool")
	eq(t, l.Source, "https://danbooru.donmai.us/pools/9")
	eq(t, urls(l.Items), []string{"https://cdn.donmai.us/original/2.jpg", "https://cdn.donmai.us/original/3.jpg", "https://cdn.donmai.us/original/1.jpg"})
	has(t, l.Items[0].Data, `{"id":2,"pool":{"id":9,"name":"My_Pool"}}`)
}

func faHTML(rating, extra string) string {
	return `<title>X</title><div class="submission-title"><h2> My Art </h2></div><div class="font-large inline c-contentRating--` + strings.ToLower(rating) + `">` + rating + `</div>
		<img class="blocked-content" data-tags="u_bob c_artwork_digital t_human s_wolf male oc" id="submissionImg" data-fullview-src="//d.furaffinity.net/art/bob/1/1.bob_x.png"
		data-preview-src="//t.furaffinity.net/7@600-1.jpg" src="//d.furaffinity.net/art/bob/1/1.bob_x.png" />` + extra
}

func TestFuraffinity(t *testing.T) {
	full := "https://d.furaffinity.net/art/bob/1/1.bob_x.png"
	c, calls := site(map[string]any{"https://www.furaffinity.net/view/7/": faHTML("Adult", ""), full: func(Req) any { return &Resp{Status: 200, Size: 1 << 20} }})
	l := listing(t, c, furaffinity, "https://furaffinity.net/full/7", "")
	eq(t, l.Source, "https://www.furaffinity.net/view/7/")
	eq(t, urls(l.Items), []string{full})
	eq(t, l.Items[0].Tags, []string{"bob", "artwork_digital", "human", "wolf", "male", "oc"})
	eq(t, l.Items[0].Porn, true)
	has(t, l.Items[0].Data, `{"id":7,"title":"My Art","rating":"adult","artists":["bob"],"categories":["artwork_digital"],"themes":["human"],"species":["wolf"],"tags":["male","oc"]}`)
	eq(t, (*calls)[1].Method, "HEAD")

	c, _ = site(map[string]any{"https://www.furaffinity.net/view/7/": faHTML("General", ""), full: func(Req) any { return &Resp{Status: 200, Size: 20 << 20} }})
	l = listing(t, c, furaffinity, "https://www.furaffinity.net/view/7/", "")
	eq(t, urls(l.Items), []string{"https://t.furaffinity.net/7@600-1.jpg"}) // over 10 MB: the preview
	eq(t, l.Items[0].Porn, false)

	// A guest gets no image of a mature or adult submission
	c, _ = site(map[string]any{"https://www.furaffinity.net/view/7/": `<body class="c-bodyColor" id="pageid-mature-content-error">`})
	_, err := listErr(c, furaffinity, "https://www.furaffinity.net/view/7/", "")
	if se, ok := err.(*StatusError); !ok || se.Status != 403 {
		t.Fatal(err)
	}
	c, _ = site(map[string]any{"https://www.furaffinity.net/view/7/": "<html>"})
	if _, err := listErr(c, furaffinity, "https://www.furaffinity.net/view/7/", ""); err == nil {
		t.Fatal("no image")
	}
}

func TestPixiv(t *testing.T) {
	px := "https://i.pximg.net/img-original/img/2020/01/09/"
	work := func(restrict, typ, pages int) J {
		return J(fmt.Sprintf(`{"error":false,"body":{"illustTitle":"2B","illustComment":"c","illustType":%d,"xRestrict":%d,"aiType":1,"userId":"3","userName":"kuro","createDate":"2020-01-08T18:39:00+00:00",
			"width":1800,"height":2099,"pageCount":%d,"bookmarkCount":5,"viewCount":9,"tags":{"tags":[{"tag":"ニーア","translation":{"en":"NieR"}},{"tag":"2B"},{"tag":"2b"}]}}}`, typ, restrict, pages))
	}
	pages := J(`{"error":false,"body":[{"urls":{"original":"` + px + `1_p0.png","regular":"https://i.pximg.net/img-master/1_p0_master1200.jpg"}},{"urls":{"original":"` + px + `1_p1.jpg","regular":"x"}}]}`)
	c, calls := site(map[string]any{"https://www.pixiv.net/ajax/illust/1": work(0, 1, 2), "https://www.pixiv.net/ajax/illust/1/pages": pages,
		px + "1_p0.png": func(Req) any { return &Resp{Status: 200, Size: 20 << 20} }}) // too big: the regular file
	l := listing(t, c, pixiv, "https://www.pixiv.net/en/artworks/1", "")
	eq(t, (*calls)[0].Headers["Referer"], "https://www.pixiv.net/")
	eq(t, l.Source, "https://www.pixiv.net/artworks/1")
	eq(t, title(l), "2B") // a comic of 2 pages
	eq(t, urls(l.Items), []string{"https://i.pximg.net/img-master/1_p0_master1200.jpg", px + "1_p1.jpg"})
	eq(t, l.Items[0].Tags, []string{"ニーア", "nier", "2b"})
	eq(t, l.Items[0].Porn, false)
	has(t, l.Items[1].Data, `{"id":1,"title":"2B","user":{"id":"3","name":"kuro"},"width":1800,"pages":2,"page":2,"bookmarks":5}`)
	eq(t, pixiv.Headers["Referer"], "https://www.pixiv.net/")

	c, _ = site(map[string]any{"https://www.pixiv.net/ajax/illust/1": work(0, 1, 1), "https://www.pixiv.net/ajax/illust/1/pages": J(`{"body":[{"urls":{"original":"` + px + `1_p0.jpg","regular":""}}]}`)})
	l = listing(t, c, pixiv, "https://www.pixiv.net/artworks/1", "")
	eq(t, title(l), "<nil>")
	eq(t, len(l.Items), 1)

	c, _ = site(map[string]any{"https://www.pixiv.net/ajax/illust/1": work(0, 2, 5)}) // ugoira
	eq(t, len(listing(t, c, pixiv, "https://www.pixiv.net/artworks/1", "").Items), 0)

	c, _ = site(map[string]any{"https://www.pixiv.net/ajax/illust/1": work(1, 1, 1)}) // R-18: the pages answer 404 to a guest
	_, err := listErr(c, pixiv, "https://www.pixiv.net/artworks/1", "")
	if se, ok := err.(*StatusError); !ok || se.Status != 403 {
		t.Fatal(err)
	}
}
