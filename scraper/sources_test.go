package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

type J = json.RawMessage

func TestScrape(t *testing.T) {
	hits := scrape(`<h1>A &amp; <b>B</b> &#39;x&#39;</h1><a href="/x">1</a><h1>C</h1>`, "h1", "a")
	var got [][2]string
	for _, h := range hits {
		got = append(got, [2]string{h.Sel, h.Text})
	}
	eq(t, got, [][2]string{{"h1", "A & B 'x'"}, {"a", "1"}, {"h1", "C"}})
	eq(t, hits[1].Attrs["href"], "/x")
}

func TestImgSrc(t *testing.T) {
	eq(t, imgSrc(map[string]string{"src": "data:x", "data-src": " //cdn.test/a.jpg "}, "https://x.test/p"), "https://cdn.test/a.jpg")
	eq(t, imgSrc(map[string]string{"data-original": "/b.png"}, "https://x.test/p"), "https://x.test/b.png")
	eq(t, imgSrc(map[string]string{}, "https://x.test/"), "")
}

func TestNumbered(t *testing.T) {
	eq(t, numbered("https://i.test/001/1/", map[string]string{"1": "j,1,1", "2": "p,1,1", "3": "g,1,1", "4": "w,1,1", "10": "j,1,1"}),
		[]string{"https://i.test/001/1/1.jpg", "https://i.test/001/1/2.png", "https://i.test/001/1/3.gif", "https://i.test/001/1/4.webp", "https://i.test/001/1/10.jpg"})
}

func TestLinkTags(t *testing.T) {
	g := linkTags(scrape(`<a href="/artist/koari/">k</a><a href="/tag/sole-male/">s</a><a href="/tag/sole-male/">s</a><a href="/other/x/">o</a>`, "a"))
	eq(t, g.flat(), []string{"koari", "sole_male"})
	eq(t, g.m, map[string][]string{"artists": {"koari"}, "tags": {"sole_male", "sole_male"}})
}

func TestMatch(t *testing.T) {
	for raw, want := range map[string]*Source{
		"https://telegra.ph/Some-Page-01-01":                       telegraph,
		"https://e621.net/posts/123?q=x":                           e621,
		"https://e621.net/pools/5":                                 e621,
		"https://nhentai.net/g/177013/":                            nhentai,
		"https://e-hentai.org/g/618395/0439fa3666/":                ehentai,
		"https://hitomi.la/doujinshi/some-title-english-1000.html": hitomi,
		"https://hitomi.la/reader/1000.html":                       hitomi,
		"https://imhentai.xxx/gallery/1/":                          imhentai,
		"https://hentaifox.com/gallery/1/":                         hentaifox,
		"https://asmhentai.com/g/1/":                               asmhentai,
		"https://www.8muses.com/comics/album/A/B":                  muses,
		"https://comics.8muses.com/porn/album/A/B":                 muses,
		"https://multporn.net/comics/adult_time_mini":              multporn,
		"https://allporncomic.com/porncomic/10-am/":                allporncomic,
		"https://allporncomic.com/porncomic/10-am/1-10-am/":        allporncomic,
		"https://kemono.su/patreon/user/1/post/2":                  kemono,
		"https://kemono.cr/patreon/user/1":                         kemono,
		"https://e621.net/posts":                                   nil,
		"https://nhentai.net/":                                     nil,
		"https://e-hentai.org/":                                    nil,
		"https://kemono.cr/patreon":                                nil,
		"https://telegra.ph/a/b":                                   nil,
	} {
		u, _ := url.Parse(raw)
		if got := sourceOf(u); got != want {
			t.Errorf("%s: got %v", raw, got)
		}
	}
}

func TestTelegraph(t *testing.T) {
	c, calls := site(map[string]any{"https://api.telegra.ph/getPage/My-Page-11-12?return_content=true": J(`{"ok":true,"result":{"title":"My Page","author_name":"ann","content":[
		"text",{"tag":"figure","children":[{"tag":"img","attrs":{"src":"/file/a.jpg"}}]},{"tag":"p","children":["x",{"tag":"img","attrs":{"src":"https://cdn.test/b.png"}}]}]}}`)})
	l := listing(t, c, telegraph, "https://telegra.ph/My-Page-11-12/", "")
	eq(t, l.Source, "https://telegra.ph/My-Page-11-12")
	eq(t, title(l), "My Page")
	eq(t, urls(l.Items), []string{"https://telegra.ph/file/a.jpg", "https://cdn.test/b.png"})
	has(t, l.Data, `{"title":"My Page","author_name":"ann"}`)
	eq(t, len(*calls), 1)
}

func TestNhentai(t *testing.T) {
	gallery := J(`{"id":696313,"media_id":"4321238","title":{"english":"[Circle] Long Title [Digital]","japanese":"日本語","pretty":"Short Title"},"scanlator":"",
		"upload_date":1794492841,"num_pages":2,"num_favorites":55,"tags":[{"type":"category","name":"doujinshi"},{"type":"language","name":"japanese"},
		{"type":"artist","name":"fuetakishi"},{"type":"group","name":"shoot the moon"},{"type":"parody","name":"original"},{"type":"character","name":"some girl"},
		{"type":"tag","name":"sole female"}],"pages":[{"number":1,"path":"galleries/4321238/1.webp"},{"number":2,"path":"galleries/4321238/2.jpg"}]}`)
	c, _ := site(map[string]any{"https://nhentai.net/api/v2/galleries/696313": gallery})
	l := listing(t, c, nhentai, "https://nhentai.net/g/696313/2/", "")
	eq(t, l.Source, "https://nhentai.net/g/696313/")
	eq(t, title(l), "Short Title")
	eq(t, urls(l.Items), []string{"https://i1.nhentai.net/galleries/4321238/1.webp", "https://i1.nhentai.net/galleries/4321238/2.jpg"})
	eq(t, l.Tags, []string{"doujinshi", "japanese", "fuetakishi", "shoot_the_moon", "original", "some_girl", "sole_female"})
	has(t, l.Data, `{"id":696313,"artists":["fuetakishi"],"groups":["shoot_the_moon"],"parodies":["original"],"characters":["some_girl"],"languages":["japanese"],
		"categories":["doujinshi"],"tags":["sole_female"],"pages":2,"favorites":55,"uploaded":"2026-11-12T14:14:01.000Z"}`)
	eq(t, l.Next, "")

	c, _ = site(nil)
	if _, err := listErr(c, nhentai, "https://nhentai.net/g/1/", ""); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatal(err)
	}
}

func TestEhentai(t *testing.T) {
	meta := `{"gid":618395,"token":"0439fa3666","title":"(Kouroumu 8) [Handful Happiness!] TOUHOU GUNMANIA A2","title_jpn":"東方","category":"Non-H","uploader":"ave",
		"posted":"1376110208","filecount":"25","filesize":51210504,"rating":"4.55","tags":["language:japanese","parody:touhou project","character:hong meiling",
		"group:handful happiness","artist:nanahara fuyuki","other:full color","female:full color"]}`
	base := "https://e-hentai.org/g/618395/0439fa3666/"
	listingPage := func(p int) string {
		var b strings.Builder
		b.WriteString(`<table class="ptt"><tr><td class="ptdd">&lt;</td>`)
		for i := range 25 {
			fmt.Fprintf(&b, `<td><a href="%s?p=%d">%d</a></td>`, base, i, i+1)
		}
		fmt.Fprintf(&b, `<td><a href="%s?p=1">&gt;</a></td></tr></table><div id="gdt" class="gt200"><a href="https://e-hentai.org/s/h%d/618395-%d"><div title="Page %d"></div></a></div>`, base, p, p+1, p+1)
		return b.String()
	}
	routes := map[string]any{"https://api.e-hentai.org/api.php": J(`{"gmetadata":[` + meta + `]}`)}
	for p := range 25 {
		routes[fmt.Sprintf("%s?p=%d", base, p)] = listingPage(p)
	}

	c, calls := site(routes)
	l := listing(t, c, ehentai, base, "")
	eq(t, l.Source, base)
	eq(t, title(l), "(Kouroumu 8) [Handful Happiness!] TOUHOU GUNMANIA A2")
	eq(t, l.Tags, []string{"japanese", "touhou_project", "hong_meiling", "handful_happiness", "nanahara_fuyuki", "full_color", "non-h"})
	has(t, l.Data, `{"gid":618395,"title_jpn":"東方","category":"Non-H","uploader":"ave","filecount":"25","pages":25,"rating":"4.55"}`)
	eq(t, len(l.Items), 19)
	eq(t, l.Items[0], Item{Page: "https://e-hentai.org/s/h0/618395-1"})
	eq(t, l.Next, "19")
	var body any
	_ = json.Unmarshal([]byte((*calls)[0].Body), &body)
	has(t, body, `{"method":"gdata","gidlist":[[618395,"0439fa3666"]],"namespace":1}`)
	eq(t, (*calls)[1].Headers["Cookie"], "nw=1")

	c, calls = site(routes)
	l = listing(t, c, ehentai, base, "19")
	eq(t, l.Title, (*string)(nil))
	eq(t, l.Data, nil)
	eq(t, len(l.Items), 6)
	eq(t, l.Items[5], Item{Page: "https://e-hentai.org/s/h24/618395-25"})
	eq(t, l.Next, "")
	for _, q := range *calls {
		if strings.Contains(q.URL, "api.php") {
			t.Fatal("metadata asked again")
		}
	}

	c, _ = site(map[string]any{
		"https://e-hentai.org/s/ok/1-1":    `<div id="i3"><a><img id="img" src="https://h.hath.network/h/abc/IMG_0032.webp" style="height:1808px"></a></div>`,
		"https://e-hentai.org/s/limit/1-2": `<div id="i3"><img id="img" src="https://ehgt.org/g/509.gif"></div>`,
	})
	src, err := ehentai.Resolve(context.Background(), c, "https://e-hentai.org/s/ok/1-1")
	eq(t, src, "https://h.hath.network/h/abc/IMG_0032.webp")
	eq(t, err, nil)
	if _, err := ehentai.Resolve(context.Background(), c, "https://e-hentai.org/s/limit/1-2"); err == nil || !strings.Contains(err.Error(), "bandwidth") {
		t.Fatal(err)
	}
}

func TestHitomi(t *testing.T) {
	A := "5e4dd8fcc183062842ee3bf02392a05b735688be7e6064784b813c822722a346" // g = 0x634 = 1588
	B := "27c99fd7b306bbace5aa2e7928279bdd9a9c78633255f4ae8ce3aa4f33cbf175" // g = 0x517 = 1303
	info := `{"blocked":0,"id":1000,"title":"Honjitsu no Otooshi 2006 Summer","japanese_title":"本日のお通し","type":"doujinshi","language":"japanese",
		"date":"2007-05-25 21:39:00-05","datepublished":"2006-08-11","artists":[{"artist":"nagisawa you","url":"/artist/x"}],
		"groups":[{"group":"nagisawaya","url":"/group/x"},{"group":"simasima system","url":"/group/y"}],"parodys":[{"parody":"zero no tsukaima","url":"/series/x"}],
		"characters":[{"character":"louise francoise","url":"/character/x"}],"tags":[{"tag":"c70","url":"/tag/c70"},{"tag":"footjob","female":1,"male":"","url":"/tag/x"}],
		"files":[{"hash":"` + A + `","name":"1.jpg","hasavif":1,"width":1,"height":1},{"hash":"` + B + `","name":"2.png","width":1,"height":1}]}`
	gg := "'use strict';\ngg = { m: function(g) {\nvar o = 1;\nswitch (g) {\ncase 1588:\ncase 99:\no = 0; break;\n}\nreturn o;\n},\ns: function(h) { var m = /(..)(.)$/.exec(h); return parseInt(m[2]+m[1], 16).toString(10); },\nb: '1794492002/'\n};"
	c, calls := site(map[string]any{"https://ltn.gold-usergeneratedcontent.net/galleries/1000.js": "var galleryinfo = " + info, "https://ltn.gold-usergeneratedcontent.net/gg.js": gg})
	l := listing(t, c, hitomi, "https://hitomi.la/doujinshi/honjitsu-japanese-1000.html", "")
	eq(t, l.Source, "https://hitomi.la/galleries/1000.html")
	eq(t, title(l), "Honjitsu no Otooshi 2006 Summer")
	eq(t, urls(l.Items), []string{
		"https://w1.gold-usergeneratedcontent.net/1794492002/1588/" + A + ".webp",      // in the switch: subdomain 0 + 1
		"https://2.gold-usergeneratedcontent.net/images/1794492002/1303/" + B + ".png", // no webp: the original, default subdomain 1 + 1
	})
	eq(t, l.Tags, []string{"nagisawa_you", "nagisawaya", "simasima_system", "zero_no_tsukaima", "louise_francoise", "c70", "footjob", "japanese", "doujinshi"})
	has(t, l.Data, `{"id":1000,"japanese_title":"本日のお通し","artists":["nagisawa_you"],"parodies":["zero_no_tsukaima"],"pages":2,"date":"2007-05-25 21:39:00-05","published":"2006-08-11"}`)
	eq(t, hitomi.Headers, map[string]string{"Referer": "https://hitomi.la/"})
	eq(t, (*calls)[0].Headers["Referer"], "https://hitomi.la/")
}

func TestImhentai(t *testing.T) {
	page := `<div class="right_details"><h1>(C71) [Arisan-Antenna (Koari)] Eat The Rich! (Sukatto Golf Pangya)</h1><p class="subtitle">(C71) 日本語</p>
    <ul class="galleries_info"><li><span class='tags_text'>Parodies:</span> <a class='tag btn' href='/parody/pangya/'>pangya <span class='badge'>132</span> </a></li>
    <li><span class='tags_text'>Tags:</span> <a class='tag btn' href='/tag/catgirl/'>catgirl <span class='badge'>30</span> </a><a class='tag btn' href='/tag/sole-male/'>sole male <span class='badge'>29</span> </a></li>
    <li><a class='tag btn' href='/artist/koari/'>koari</a></li><li><a href='/group/arisan-antenna/'>arisan-antenna</a></li><li><a href='/language/japanese/'>japanese</a></li><li><a href='/category/doujinshi/'>doujinshi</a></li>
    <li class="pages">Pages: 3</li></ul></div>`
	reader := `<img id="gimg" class="preloader image_1" src="https://m1.imhentai.xxx/001/8b7a63vwdj/1.jpg"><script>var g_th = $.parseJSON('{"1":"j,1050,1500","2":"p,1050,1500","3":"w,1050,1500"}');</script>`
	c, _ := site(map[string]any{"https://imhentai.xxx/gallery/1/": page, "https://imhentai.xxx/view/1/1/": reader})
	l := listing(t, c, imhentai, "https://imhentai.xxx/gallery/1/", "")
	eq(t, l.Source, "https://imhentai.xxx/gallery/1/")
	eq(t, title(l), "(C71) Eat The Rich! (Sukatto Golf Pangya)") // [textual tags] dropped
	eq(t, urls(l.Items), []string{"https://m1.imhentai.xxx/001/8b7a63vwdj/1.jpg", "https://m1.imhentai.xxx/001/8b7a63vwdj/2.png", "https://m1.imhentai.xxx/001/8b7a63vwdj/3.webp"})
	eq(t, l.Tags, []string{"pangya", "catgirl", "sole_male", "koari", "arisan_antenna", "japanese", "doujinshi"})
	has(t, l.Data, `{"id":"1","title":"(C71) [Arisan-Antenna (Koari)] Eat The Rich! (Sukatto Golf Pangya)","subtitle":"(C71) 日本語","artists":["koari"],"groups":["arisan_antenna"],"parodies":["pangya"],"pages":3}`)
	eq(t, imhentai.Headers, map[string]string{"Referer": "https://imhentai.xxx/"})
}

func TestHentaifox(t *testing.T) {
	page := `<div class="info"><h1>Winter&#39;s Tale</h1>
    <ul class="parodies"><li><a class='tag_btn ' href='/parody/fate-stay-night/'>fate stay night <span class='t_badge'>505</span></a></li></ul>
    <ul class="characters"><li><a class='tag_btn ' href='/character/rin-tosaka/'>rin tosaka</a></li></ul>
    <ul class="tags"><li><a class='tag_btn ' href='/tag/anal/'>anal</a></li></ul>
    <ul class="artists"><li><a class='tag_btn ' href='/artist/zenki/'>zenki</a></li></ul>
    <ul class="languages"><li><a class='tag_btn' href='/language/english/'>english</a></li></ul>
    <ul class="categories"><li><a class='tag_btn' href='/category/doujinshi/'>doujinshi</a></li></ul>
    <span class="i_text pages">Pages: 2</span><span class="i_text pages">Posted: 19 years ago</span></div>`
	reader := `<a class="next_img"><img id="gimg" class="lazy" src="data:image/svg+xml,x" data-src="https://i.hentaifox.com/001/12331/1.jpg"></a><script>var g_th = $.parseJSON('{"1":"j,720,1000","2":"p,720,1000"}');</script>`
	c, _ := site(map[string]any{"https://hentaifox.com/gallery/1/": page, "https://hentaifox.com/g/1/1/": reader})
	l := listing(t, c, hentaifox, "https://hentaifox.com/gallery/1/", "")
	eq(t, l.Source, "https://hentaifox.com/gallery/1/")
	eq(t, title(l), "Winter's Tale")
	eq(t, urls(l.Items), []string{"https://i.hentaifox.com/001/12331/1.jpg", "https://i.hentaifox.com/001/12331/2.png"})
	eq(t, l.Tags, []string{"fate_stay_night", "rin_tosaka", "anal", "zenki", "english", "doujinshi"})
	has(t, l.Data, `{"id":"1","title":"Winter's Tale","parodies":["fate_stay_night"],"characters":["rin_tosaka"],"artists":["zenki"],"languages":["english"],"categories":["doujinshi"],"pages":2}`)
}

func TestAsmhentai(t *testing.T) {
	page := `<div class="info"><h1>(C88) [Z-FRONT (Kagato)] Seijya na Yuusya (Rokka no Yuusha)</h1><h2>(C88) 性者な勇者</h2><ul>
    <div class="tags"><h3>Parodies:</h3><div class="tag_list"><a href="/parody/rokka-no-yuusha/"><span class="badge tag">rokka no yuusha <span class="gallery_count">(7)</span></span></a></div></div></ul>
    <ul><div class="tags"><h3>Tags:</h3><div class="tag_list"><a href="/tag/big-breasts/"><span class="badge tag">big breasts <span class="gallery_count">(235,177)</span></span></a></div></div></ul>
    <ul><div class="tags"><h3>Artists:</h3><div class="tag_list"><a href="/artist/kagato/"><span class="badge tag">kagato</span></a></div></div></ul>
    <div class="pages"><h3>Pages: 3</h3></div></div>`
	reader := `<button class="pages_btn"><span class="cr">1</span> <span class="sp">of</span> <span class="tp">3</span></button>
    <div class="reader_overlay"><a class="fw_img"><img id="fimg" class="lazy" src="data:image/svg+xml,x" data-src="//images.asmhentai.com/001/1/1.jpg"></a></div>`
	c, _ := site(map[string]any{"https://asmhentai.com/g/1/": page, "https://asmhentai.com/gallery/1/1/": reader})
	l := listing(t, c, asmhentai, "https://asmhentai.com/g/1/", "")
	eq(t, l.Source, "https://asmhentai.com/g/1/")
	eq(t, title(l), "(C88) [Z-FRONT (Kagato)] Seijya na Yuusya (Rokka no Yuusha)")
	eq(t, urls(l.Items), []string{"https://images.asmhentai.com/001/1/1.jpg", "https://images.asmhentai.com/001/1/2.jpg", "https://images.asmhentai.com/001/1/3.jpg"})
	eq(t, l.Tags, []string{"rokka_no_yuusha", "big_breasts", "kagato"})
	has(t, l.Data, `{"id":"1","subtitle":"(C88) 性者な勇者","parodies":["rokka_no_yuusha"],"tags":["big_breasts"],"artists":["kagato"],"pages":3}`)
}

func TestMuses(t *testing.T) {
	crumbs := func(names ...string) string {
		s := `<div class="top-menu-breadcrumb"><ol><li><a href="/porn"><i class="fa fa-home"></i></a></li>`
		for _, n := range names {
			s += fmt.Sprintf(`<li><a href="/porn/album/%s">%s</a></li>`, strings.ReplaceAll(n, " ", "-"), n)
		}
		return s + `</ol></div>`
	}
	tile := func(n int) string {
		return fmt.Sprintf(`<a class="c-tile" href="/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/%d"><div class="image"><img src="/image/th/hash%d.jpg"></div></a>`, n, n)
	}
	path := "/porn/album/Various-Authors/Disarten-Comics/Artwork-2"
	c, _ := site(map[string]any{
		"https://comics.8muses.com" + path:                                                   crumbs("Various Authors", "Disarten Comics", "Artwork 2") + `<div class="gallery">` + tile(1) + tile(2) + `</div>`,
		"https://comics.8muses.com/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/1": `<div class="album-tags"><a href="/search/tag/big-boobs">big boobs</a><a href="/search/tag/milf">milf</a></div>`,
	})
	l := listing(t, c, muses, "https://www.8muses.com"+path, "")
	eq(t, l.Source, "https://comics.8muses.com"+path)
	eq(t, title(l), "Artwork 2")
	eq(t, urls(l.Items), []string{"https://comics.8muses.com/image/fl/hash1.jpg", "https://comics.8muses.com/image/fl/hash2.jpg"})
	eq(t, l.Tags, []string{"disarten_comics", "big_boobs", "milf"}) // "various authors" is not a publisher; its second crumb is the artist
	has(t, l.Data, `{"publisher":"Various Authors","artists":["Disarten Comics"],"circles":[],"series":[],"tags":["big boobs","milf"],"pages":2}`)

	c, _ = site(map[string]any{
		"https://comics.8muses.com/porn/album/MilfToon-Comics/Drawn-Sex/Issue-1":             crumbs("MilfToon Comics", "Drawn Sex", "Issue 1") + `<div class="gallery">` + tile(1) + `</div>`,
		"https://comics.8muses.com/porn/picture/Various-Authors/Disarten-Comics/Artwork-2/1": "",
	})
	l = listing(t, c, muses, "https://comics.8muses.com/porn/album/MilfToon-Comics/Drawn-Sex/Issue-1", "")
	eq(t, title(l), "Drawn Sex - Issue 1")
	eq(t, l.Tags, []string{"milftoon_comics", "drawn_sex"})
	has(t, l.Data, `{"circles":["MilfToon Comics"],"series":["Drawn Sex"],"artists":[]}`)

	c, _ = site(map[string]any{"https://comics.8muses.com/porn/album/Various-Authors": crumbs("Various Authors") + `<div class="gallery"><a class="c-tile" href="/porn/album/Various-Authors/X"><img src="/image/th/a.jpg"></a></div>`})
	if _, err := listErr(c, muses, "https://comics.8muses.com/porn/album/Various-Authors", ""); err == nil || !strings.Contains(err.Error(), "not an album") {
		t.Fatal(err)
	}
}

func TestMultporn(t *testing.T) {
	page := `<head><link rel="shortlink" href="https://multporn.net/node/21"><meta name="dcterms.date" content="2015-06-01T14:53-04:00">
    <script>jQuery.extend(Drupal.settings, {"juicebox":{"x":{"configUrl":"\/juicebox\/xml\/field\/node\/21\/field_com_pages\/full?checksum=b82863","containerId":"x"}}});</script></head>
    <ul class="menu"><li><a href="/comics">menu</a></li></ul>
    <h1 class="title" id="page-title"> Adult Time Mini </h1>
    <article class="node node-comics"><ul class="links inline"><li><a href="/authors_comics/coldfusion">ColdFusion</a></li></ul>
    <ul class="links inline"><li><a href="/comics/adventure_time">Adventure Time</a></li><li><a href="/comics/ongoings">Ongoings</a></li></ul>
    <ul class="links inline"><li><a href="/characters/finn_the_human">Finn the Human</a></li></ul>
    <ul class="links inline"><li><a href="/category/fantasy">Fantasy</a></li><li><a href="/user_tags/licking_tag">Licking</a></li><li><a href="/user_tags/young_tag?r=3">Young</a></li></ul></article>`
	xml := `<juicebox><image imageURL="https://multporn.net/m/p1.png" linkURL="https://multporn.net/f/p1.png?a=1&amp;b=2"/><image imageURL="m2" linkURL="https://multporn.net/f/p2.png"/><image imageURL="m2" linkURL="https://multporn.net/f/p2.png"/></juicebox>`
	c, calls := site(map[string]any{"https://multporn.net/comics/adult_time_mini": page, "https://multporn.net/juicebox/xml/field/node/21/field_com_pages/full?checksum=b82863": xml})
	l := listing(t, c, multporn, "https://multporn.net/comics/adult_time_mini/", "")
	eq(t, l.Source, "https://multporn.net/comics/adult_time_mini")
	eq(t, title(l), "Adult Time Mini")
	eq(t, urls(l.Items), []string{"https://multporn.net/f/p1.png?a=1&b=2", "https://multporn.net/f/p2.png"})
	eq(t, l.Tags, []string{"coldfusion", "adventure_time", "ongoing", "fantasy", "licking", "young", "finn_the_human"})
	has(t, l.Data, `{"title":"Adult Time Mini","artists":["coldfusion"],"series":["adventure_time"],"characters":["finn_the_human"],"tags":["ongoing","fantasy","licking","young"],"pages":2,"date":"2015-06-01T14:53-04:00"}`)
	eq(t, (*calls)[1].Headers["Referer"], "https://multporn.net/comics/adult_time_mini")

	c, _ = site(map[string]any{"https://multporn.net/comics/adventure_time": `<h1 id="page-title">Adventure Time</h1>`})
	if _, err := listErr(c, multporn, "https://multporn.net/comics/adventure_time", ""); err == nil || !strings.Contains(err.Error(), "no images") {
		t.Fatal(err)
	}
}

func TestAllporncomic(t *testing.T) {
	S := "https://allporncomic.com/porncomic/10-am/"
	chapterLi := func(slug string, date bool) string {
		d := fmt.Sprintf(`<a href="%s%s/" class="c-new-tag"></a>`, S, slug)
		if date {
			d = "<i>July 25, 2020</i>"
		}
		return fmt.Sprintf(`<li class="wp-manga-chapter "> <a href="%s%s/"> %s </a><span class="chapter-release-date">%s</span></li>`, S, slug, slug, d)
	}
	series := func(n int) string {
		s := `<head><title>10 AM [LoseKorntrol] Porn Comic | AllPornComic</title></head>
    <div class="post-content"><div class="summary-content"><div class="artist-content"><a href="https://allporncomic.com/porncomicartist/hijab-3dx/" rel="tag">Hijab 3DX</a></div></div>
    <div class="summary-content"><div class="genres-content"><a href="https://allporncomic.com/porncomic-category/3dd/" rel="tag">3D</a>, <a href="https://allporncomic.com/porncomic-category/glory-hole/" rel="tag">Glory Hole</a></div></div>
    <div class="summary-content"><a href="https://allporncomic.com/characters/lara-croft/">Lara Croft</a></div>
    <div class="summary-content">OnGoing</div></div>
    <ul class="main"><li class="wp-manga-chapter "> <a href="` + S + `fake1/"> tb1794411814 </a><span class="chapter-release-date"><a class="c-new-tag"></a></span></li>`
		for i := range n {
			s += chapterLi(fmt.Sprintf("c%d", n-i), true)
		}
		return s + chapterLi("fake2", false) + `</ul>`
	}
	chapterPage := func(k string) string {
		return fmt.Sprintf(`<head><title>10 AM - %s - AllPornComic</title></head><div class="page-break "> <img id="image-0" data-src=" https://cdn.test/%s/01.jpg " class="wp-manga-chapter-img"></div><div class="page-break "> <img id="image-1" data-src="https://cdn.test/%s/02.jpg"></div><div class="page-break "> <img id="image-1" data-src="https://cdn.test/%s/02.jpg"></div>`, k, k, k, k)
	}
	routes := map[string]any{S: series(21)}
	for i := 1; i <= 21; i++ {
		routes[fmt.Sprintf("%sc%d/", S, i)] = chapterPage(fmt.Sprintf("c%d", i))
	}
	c, calls := site(routes)
	l := listing(t, c, allporncomic, "https://allporncomic.com/manga/10-am/", "")
	eq(t, l.Source, S)
	eq(t, title(l), "10 AM [LoseKorntrol]")
	eq(t, l.Tags, []string{"hijab_3dx", "3d", "glory_hole", "lara_croft", "ongoing"})
	has(t, l.Data, `{"title":"10 AM [LoseKorntrol]","artists":["Hijab 3DX"],"tags":["3D","Glory Hole"],"characters":["Lara Croft"],"status":"ongoing","chapters":21}`)
	eq(t, len(l.Items), 38)
	eq(t, urls(l.Items)[:3], []string{"https://cdn.test/c1/01.jpg", "https://cdn.test/c1/02.jpg", "https://cdn.test/c2/01.jpg"}) // trimmed, deduped
	eq(t, len(*calls), 20)                                                                                                       // the series page and 19 chapters
	var rest []string
	_ = json.Unmarshal([]byte(l.Next), &rest)
	eq(t, rest, []string{S + "c20/", S + "c21/"})

	l2 := listing(t, c, allporncomic, S, l.Next)
	eq(t, urls(l2.Items), []string{"https://cdn.test/c20/01.jpg", "https://cdn.test/c20/02.jpg", "https://cdn.test/c21/01.jpg", "https://cdn.test/c21/02.jpg"})
	eq(t, l2.Next, "")

	c, _ = site(map[string]any{S: `<head><title>X Porn Comic</title></head><ul>` + chapterLi("a", false) + chapterLi("b", false) + `</ul>`, S + "a/": chapterPage("a"), S + "b/": chapterPage("b")})
	l = listing(t, c, allporncomic, S, "")
	var dirs []string
	for _, u := range urls(l.Items) {
		dirs = append(dirs, strings.Split(u, "/")[3])
	}
	eq(t, dirs, []string{"b", "b", "a", "a"}) // all chapters when none has a date

	c, _ = site(map[string]any{S + "c1/": chapterPage("c1")})
	l = listing(t, c, allporncomic, S+"c1/", "")
	eq(t, l.Source, S+"c1/")
	eq(t, title(l), "10 AM - c1")
	eq(t, urls(l.Items), []string{"https://cdn.test/c1/01.jpg", "https://cdn.test/c1/02.jpg"})
	eq(t, l.Next, "")
}

func TestKemono(t *testing.T) {
	profile := func(count int) J {
		return J(fmt.Sprintf(`{"id":"5564244","name":"theobrobine","service":"patreon","post_count":%d,"indexed":"2020-09-30T06:13:38","updated":"2026-03-20T21:56:49"}`, count))
	}
	post := func(id string, tags ...string) string {
		tj, _ := json.Marshal(append([]string{}, tags...))
		return fmt.Sprintf(`{"id":"%[1]s","user":"5564244","service":"patreon","title":"Post %[1]s","content":"text","published":"2026-03-02T12:06:15",
			"file":{"name":"a.png","path":"/aa/bb/%[1]s.png"},"attachments":[{"name":"a.png","path":"/aa/bb/%[1]s.png"},{"name":"b.zip","path":"/cc/dd/%[1]s.bin"},
			{"name":"c.gif","path":"/ee/ff/%[1]s.gif"},{"name":"d.mp4","path":"/gg/hh/%[1]s.mp4"}],"tags":%[2]s}`, id, tj)
	}
	api := "https://kemono.cr/api/v1/patreon/user/5564244"

	c, calls := site(map[string]any{api + "/post/152036345": J(`{"post":` + post("152036345", "animation", "cowgirl position") + `,"attachments":[]}`), api + "/profile": profile(3)})
	l := listing(t, c, kemono, "https://kemono.su/patreon/user/5564244/post/152036345", "")
	eq(t, l.Source, "https://kemono.cr/patreon/user/5564244/post/152036345")
	eq(t, title(l), "Post 152036345")
	eq(t, urls(l.Items), []string{"https://kemono.cr/data/aa/bb/152036345.png", "https://kemono.cr/data/ee/ff/152036345.gif"})
	eq(t, l.Tags, []string{"theobrobine", "patreon", "animation", "cowgirl_position"})
	has(t, l.Data, `{"creator":{"name":"theobrobine","post_count":3},"post":{"id":"152036345","title":"Post 152036345","published":"2026-03-02T12:06:15","tags":["animation","cowgirl position"]}}`)
	eq(t, (*calls)[0].Headers["Accept"], "text/css")
	eq(t, kemono.Headers, map[string]string{"Referer": "https://kemono.cr/"})

	// 3 posts, the API gives the newest first
	c, _ = site(map[string]any{api + "/profile": profile(3), api + "/posts?o=0": J("[" + post("3", "t3") + "," + post("2") + "," + post("1") + "]")})
	l = listing(t, c, kemono, "https://kemono.cr/patreon/user/5564244", "")
	eq(t, l.Source, "https://kemono.cr/patreon/user/5564244")
	eq(t, title(l), "theobrobine")
	eq(t, l.Tags, []string{"theobrobine", "patreon"})
	has(t, l.Data, `{"creator":{"id":"5564244","post_count":3}}`)
	var pngs []string
	for _, u := range urls(l.Items) {
		if strings.HasSuffix(u, ".png") {
			pngs = append(pngs, u)
		}
	}
	eq(t, pngs, []string{"https://kemono.cr/data/aa/bb/1.png", "https://kemono.cr/data/aa/bb/2.png", "https://kemono.cr/data/aa/bb/3.png"})
	last := l.Items[len(l.Items)-1]
	eq(t, last.URL, "https://kemono.cr/data/ee/ff/3.gif")
	eq(t, last.Tags, []string{"t3"})
	has(t, last.Data, `{"creator":{"id":"5564244","service":"patreon"},"post":{"id":"3","title":"Post 3"}}`)
	eq(t, l.Next, "")

	routes := map[string]any{api + "/profile": profile(1020)}
	for o := 0; o <= 1000; o += 50 {
		routes[fmt.Sprintf("%s/posts?o=%d", api, o)] = J(fmt.Sprintf("[%s,%s]", post(fmt.Sprintf("n%d", o)), post(fmt.Sprintf("o%d", o)))) // newest first in a page
	}
	c, calls = site(routes)
	l = listing(t, c, kemono, "https://kemono.cr/patreon/user/5564244", "")
	eq(t, len(*calls), 21) // the profile and 20 pages: o=1000 … 50
	eq(t, urls(l.Items)[0], "https://kemono.cr/data/aa/bb/o1000.png")
	eq(t, urls(l.Items)[2], "https://kemono.cr/data/aa/bb/n1000.png")
	eq(t, l.Next, "0")
	l2 := listing(t, c, kemono, "https://kemono.cr/patreon/user/5564244", l.Next)
	eq(t, l2.Title, (*string)(nil))
	eq(t, urls(l2.Items)[0], "https://kemono.cr/data/aa/bb/o0.png")
	eq(t, l2.Next, "")
	eq(t, len(*calls), 22)
}

func TestXlecx(t *testing.T) {
	page := `<article class="page"><h1>The Magic Wands</h1><div class="page__subinfo-item"><div>Artist:</div><a href="https://xlecx.one/xfsearch/artist/jack%20draws/">jack draws</a></div>
		<div class="tags-list"><div>Tags:</div><a href="https://xlecx.one/tags/males%20only/">males only</a>, <a href="https://xlecx.one/tags/yaoi/">yaoi</a></div>
		<ul class="xfieldimagegallery testimage"><li><a href="https://xlecx.one/uploads/posts/2025-10/pg00.webp"><img data-src="/uploads/posts/2025-10/thumbs/pg00.webp"></a></li>
		<li><a href="/uploads/posts/2025-10/pg01.webp"><img data-src="/uploads/posts/2025-10/thumbs/pg01.webp"></a></li></ul></article>`
	c, _ := site(map[string]any{"https://xlecx.one/55945-the-magic-wands.html": page})
	u, _ := url.Parse("https://www.xlecx.one/55945-the-magic-wands.html?x=1")
	eq(t, sourceOf(u), xlecx)
	l := listing(t, c, xlecx, "https://xlecx.one/55945-the-magic-wands.html", "")
	eq(t, title(l), "The Magic Wands")
	eq(t, urls(l.Items), []string{"https://xlecx.one/uploads/posts/2025-10/pg00.webp", "https://xlecx.one/uploads/posts/2025-10/pg01.webp"})
	eq(t, l.Tags, []string{"jack_draws", "males_only", "yaoi"})
	has(t, l.Data, `{"title":"The Magic Wands","artists":["jack_draws"],"tags":["males_only","yaoi"],"pages":2}`)
}

// turboStream encodes v as a turbo-stream array (objects {"_<key index>": <value index>}), as React Router sends it.
func turboStream(v any) string {
	var arr []any
	var enc func(v any) int
	enc = func(v any) int {
		if v == nil {
			return -5
		}
		i := len(arr)
		arr = append(arr, nil)
		switch x := v.(type) {
		case map[string]any:
			o := map[string]int{}
			for k, val := range x {
				ki := len(arr)
				arr = append(arr, k)
				o[fmt.Sprintf("_%d", ki)] = enc(val)
			}
			arr[i] = o
		case []any:
			l := []int{}
			for _, e := range x {
				l = append(l, enc(e))
			}
			arr[i] = l
		default:
			arr[i] = x
		}
		return i
	}
	enc(v)
	b, _ := json.Marshal(arr)
	q, _ := json.Marshal(string(b))
	return `<script>window.__reactRouterContext.streamController.enqueue(` + string(q) + `);</script>`
}

func TestTailspace(t *testing.T) {
	page := func(n int) map[string]any {
		return map[string]any{"token": fmt.Sprintf("tok%d", n), "pageNumber": float64(n), "fileType": "jpg"}
	}
	comic := map[string]any{"id": float64(7746), "name": "Morning Wood", "slug": "Morning Wood (Munie)", "state": "finished", "category": "Male", "e621PoolId": nil,
		"published":         []any{"D", float64(1794009609000)},
		"artist":            map[string]any{"name": "Munie"},
		"additionalArtists": []any{},
		"tags":              []any{map[string]any{"name": "cum in mouth", "category": nil}, map[string]any{"name": "canine", "category": "species"}},
		"pages":             []any{page(2), page(1), map[string]any{"token": "old3", "pageNumber": float64(3)}}, // an old page has no file type
	}
	html := turboStream(map[string]any{"loaderData": map[string]any{"root": map[string]any{"user": nil}, "routes/pages/comic/ComicPage": map[string]any{"comic": comic}}})
	c, calls := site(map[string]any{"https://tailspace.com/c/Morning%20Wood%20%28Munie%29": html})
	for raw, want := range map[string]bool{
		"https://yiffer.xyz/Morning%20Wood%20(Munie)": true, "https://yiffer.xyz/c/Morning%20Wood%20(Munie)": true, "https://tailspace.com/c/Morning%20Wood%20(Munie)": true,
		"https://tailspace.com/browse": false, "https://tailspace.com/artist/Munie": false,
	} {
		u, _ := url.Parse(raw)
		eq(t, sourceOf(u) == tailspace, want)
	}
	l := listing(t, c, tailspace, "https://yiffer.xyz/Morning%20Wood%20(Munie)", "")
	eq(t, (*calls)[0].URL, "https://tailspace.com/c/Morning%20Wood%20%28Munie%29")
	eq(t, l.Source, "https://tailspace.com/c/Morning%20Wood%20%28Munie%29")
	eq(t, title(l), "Morning Wood")
	eq(t, urls(l.Items), []string{"https://pics.tailspace.com/comics/7746/tok1.jpg", "https://pics.tailspace.com/comics/7746/tok2.jpg", "https://pics.tailspace.com/comics/7746/old3.jpg"})
	eq(t, l.Tags, []string{"munie", "cum_in_mouth", "canine", "male"})
	has(t, l.Data, `{"id":7746,"slug":"Morning Wood (Munie)","state":"finished","pages":3,"artists":["munie"]}`)
}
