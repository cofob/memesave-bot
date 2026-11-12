package main

import (
	"cmp"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"slices"
	"sort"
	"time"
)

// Pair analysis (MODE=pair, src/analysis.ts): the memes of both pair members on one text map, compared.
// Owner 0 is pair.a ("me" in the stats), owner 1 is pair.b ("partner").
const (
	pairLimit = 8000 // memes per owner
	moodTemp  = 0.05 // softmax temperature over the mood anchors
	// compat weights
	wMixing, wCentroid, wMood, wHour = 0.35, 0.25, 0.25, 0.15
)

func runPair(p *progress) error {
	memes, vectors, err := fetch(p, pairLimit)
	if err != nil {
		return err
	}
	moods := fetchMoods()
	var raw json.RawMessage
	if err := call("GET", "/analytics", nil, &raw); err != nil {
		return err
	}
	var a pairAnalytics
	if err := json.Unmarshal(raw, &a); err != nil {
		log.Print("analytics: ", err)
	}
	r := analyzePair(memes, vectors, moods, a.Shared.HourSim, p)
	r.Analytics = raw
	r.Images = upload(p, "write", pairCharts(&a, r))
	return finish(r)
}

// fetchMoods gets the mood anchors; none on an error (404: no AI), and the result has no moods.
func fetchMoods() []mood {
	var m struct {
		Moods []mood `json:"moods"`
	}
	if err := call("GET", "/moods", nil, &m); err != nil {
		log.Print("moods: ", err)
	}
	return m.Moods
}

type mood struct {
	Key    string    `json:"key"`
	Emoji  string    `json:"emoji"`
	NameEn string    `json:"name_en"`
	NameRu string    `json:"name_ru"`
	Vector []float32 `json:"vector"`
}

// pairAnalytics is the part of GET /analytics (src/pairstats.ts pairStats with me = a, partner = b) used here.
type pairAnalytics struct {
	Lang        string
	Me, Partner pairSide
	Shared      struct{ HourSim float64 }
}

type pairSide struct {
	Name    string
	Heatmap []struct{ H, N float64 }
}

// pairResult is the pair analysis JSON (app/src/api.ts PairResult).
type pairResult struct {
	CreatedAt int64           `json:"created_at"`
	Count     [2]int          `json:"count"`
	Memes     [][5]any        `json:"memes"` // [id, kind, created, lang, owner]
	Map       pairMap         `json:"map"`
	Clusters  []pairCluster   `json:"clusters"`
	Scores    pairScores      `json:"scores"`
	Twins     [][3]any        `json:"twins"`    // [a id, b id, image cos]
	Rhymes    [][3]any        `json:"rhymes"`   // [a id, b id, text cos]
	For       [2][]string     `json:"for"`      // [owner]: the other's memes closest to owner's taste
	Surprise  [2][]string     `json:"surprise"` // [owner]: the other's memes farthest from owner's taste
	Bridge    []string        `json:"bridge"`   // a-only cluster center → … → b-only cluster center
	Sync      pairSync        `json:"sync"`
	Influence influence       `json:"influence"`
	Moods     *pairMoods      `json:"moods"` // null without anchors
	Analytics json.RawMessage `json:"analytics,omitempty"`
	Images    []string        `json:"images"`
}

type pairMap struct {
	mapOut
	Owner []int `json:"owner"`
}

type pairCluster struct {
	cluster
	Share [2]int  `json:"share"` // members per owner
	R     float64 `json:"r"`     // (nA/NA) / (nA/NA + nB/NB)
	Type  string  `json:"type"`  // "shared", "a", "b" or "" (in between)
	First int     `json:"first"` // owner who came here first (by month); -1: same month or one side only
}

type pairScores struct {
	Compat   int     `json:"compat"`
	Mixing   float64 `json:"mixing"`
	Centroid float64 `json:"centroid"`
	MoodSim  float64 `json:"moodSim"`
	HourSim  float64 `json:"hourSim"`
}

type pairSync struct {
	Months []string  `json:"months"`
	Sim    []float64 `json:"sim"`
}

type influence struct {
	Clusters [2]int `json:"clusters"` // shared clusters each owner entered first
	Twins    [2]int `json:"twins"`    // twins each owner saved first
	Score    [2]int `json:"score"`
}

type pairMoods struct {
	Keys    []string            `json:"keys"`
	Emoji   []string            `json:"emoji"`
	Names   map[string][]string `json:"names"`  // "en", "ru"
	Months  []string            `json:"months"` // the last 12 months with memes
	A       [][]float64         `json:"a"`      // [month][mood], null: no memes that month
	B       [][]float64         `json:"b"`
	Overall [2][]float64        `json:"overall"` // [owner][mood], all time
	Sim     []*float64          `json:"sim"`     // [month] 1 − JSD of a and b, null: one side has no memes
	Top     [2]int              `json:"top"`     // [owner] the mood of the year, -1: none
	Best    []string            `json:"best"`    // up to 3 months of the highest sim
}

// analyzePair compares the two owners' memes; hourSim comes from the SQL stats.
func analyzePair(memes []meme, vectors map[string][]float32, moods []mood, hourSim float64, p *progress) *pairResult {
	r := &pairResult{CreatedAt: time.Now().Unix(), Memes: make([][5]any, len(memes)), Clusters: []pairCluster{},
		Twins: [][3]any{}, Rhymes: [][3]any{}, Images: []string{}}
	tagsOf, ownerOf, created := map[string][]string{}, map[string]int{}, map[string]int64{}
	for i, m := range memes {
		tagsOf[m.ID], ownerOf[m.ID], created[m.ID] = m.Tags, m.Owner, m.Created
		r.Memes[i] = [5]any{m.ID, m.Kind, m.Created, m.Lang, m.Owner}
		r.Count[m.Owner]++
	}
	img, txt := newSpace(memes, vectors, ":i"), newSpace(memes, vectors, ":t")
	p.report("project", 0, 2)
	img.project()
	p.report("project", 1, 2)
	txt.project()
	p.report("project", 2, 2)
	p.report("cluster", 0, 1)
	labels, groups := clusters(txt, tagsOf)
	p.report("cluster", 1, 1)
	p.report("extras", 0, 1)

	n := len(txt.ids)
	owner, monthOf, pos := make([]int, n), make([]string, n), map[string]int{}
	var byOwner [2][]int
	for i, id := range txt.ids {
		owner[i], monthOf[i], pos[id] = ownerOf[id], time.Unix(created[id], 0).UTC().Format("2006-01"), i
		byOwner[owner[i]] = append(byOwner[owner[i]], i)
	}
	r.Map = pairMap{mapOut{IDs: txt.ids, XY: coords(txt.xy), XYZ: txt.xyz, Labels: labels}, owner}
	idsOf := func(idx []int) []string {
		out := []string{}
		for _, i := range idx {
			out = append(out, txt.ids[i])
		}
		return out
	}

	from, to := -1, -1 // the centers of the largest a-only and b-only clusters
	for _, g := range groups {
		c := pairCluster{cluster: g, First: -1}
		var first [2]string
		for i, l := range labels {
			if o := owner[i]; l == g.ID {
				c.Share[o]++
				if first[o] == "" || monthOf[i] < first[o] {
					first[o] = monthOf[i]
				}
			}
		}
		a, b := float64(c.Share[0])/float64(max(1, len(byOwner[0]))), float64(c.Share[1])/float64(max(1, len(byOwner[1])))
		switch c.R = a / (a + b); {
		case c.R >= 0.3 && c.R <= 0.7:
			c.Type = "shared"
		case c.R > 0.85:
			c.Type = "a"
		case c.R < 0.15:
			c.Type = "b"
		}
		c.R = round(c.R)
		if first[0] != "" && first[1] != "" {
			c.First = earlier(first[0], first[1])
		}
		if c.Type == "shared" && c.First >= 0 {
			r.Influence.Clusters[c.First]++
		}
		if c.Type == "a" && from < 0 {
			from = pos[c.Sample[0]]
		}
		if c.Type == "b" && to < 0 {
			to = pos[c.Sample[0]]
		}
		r.Clusters = append(r.Clusters, c)
	}

	// mixing: the share of the other owner's memes among the neighbors, against the share expected by chance.
	var mixing, share [2]float64
	for i, ids := range txt.idx {
		foreign := 0
		for _, j := range ids {
			if owner[j] != owner[i] {
				foreign++
			}
		}
		if len(ids) > 0 {
			share[owner[i]] += float64(foreign) / float64(len(ids)) / float64(len(byOwner[owner[i]]))
		}
	}
	for o := range 2 {
		if expected := float64(len(byOwner[1-o])) / float64(max(1, n-1)); expected > 0 {
			mixing[o] = math.Min(1, share[o]/expected)
		}
	}
	centroid := cosine(sum(txt.x, byOwner[0]), sum(txt.x, byOwner[1]))

	twin := map[string]bool{}
	for _, d := range duplicates(img, txt, func(a, b string) bool { return ownerOf[a] != ownerOf[b] }) {
		if ownerOf[d[0].(string)] == 1 {
			d[0], d[1] = d[1], d[0]
		}
		a, b := d[0].(string), d[1].(string)
		twin[a], twin[b] = true, true
		r.Twins = append(r.Twins, d)
		if o := earlier(created[a], created[b]); o >= 0 {
			r.Influence.Twins[o]++
		}
	}
	for o := range 2 {
		r.Influence.Score[o] = r.Influence.Clusters[o] + r.Influence.Twins[o]
	}

	// cross: the 5 nearest memes of the other owner (on the PCA map, which project fits from 3 memes).
	var cross [][]int
	var crossSim [][]float32
	if txt.p.n == n && n > 0 {
		cross, crossSim = knnBy(txt.p, 5, func(i, j int) bool { return owner[i] == owner[j] })
	}
	type rhyme struct {
		a, b int
		s    float64
	}
	var rhymes []rhyme
	for i, ids := range cross {
		if owner[i] != 0 || twin[txt.ids[i]] {
			continue
		}
		best := rhyme{i, -1, 0.8}
		for _, j := range ids {
			if s := dot(txt.x.row(i), txt.x.row(j)); s > best.s && s < 0.95 && !twin[txt.ids[j]] {
				best.b, best.s = j, s
			}
		}
		if best.b >= 0 {
			rhymes = append(rhymes, best)
		}
	}
	sort.SliceStable(rhymes, func(a, b int) bool { return rhymes[a].s > rhymes[b].s })
	used := map[int]bool{}
	for _, h := range rhymes {
		if len(r.Rhymes) < 40 && !used[h.b] {
			used[h.b] = true
			r.Rhymes = append(r.Rhymes, [3]any{txt.ids[h.a], txt.ids[h.b], math.Round(h.s*1e4) / 1e4})
		}
	}
	taste := make([]float64, n) // the mean similarity to the 5 nearest memes of the other owner
	for i, ss := range crossSim {
		for _, s := range ss {
			taste[i] += float64(s) / float64(len(ss))
		}
	}
	for o := range 2 {
		var cand []int
		for i, ss := range crossSim {
			if owner[i] != o && len(ss) > 0 && !twin[txt.ids[i]] {
				cand = append(cand, i)
			}
		}
		sort.SliceStable(cand, func(a, b int) bool { return taste[cand[a]] > taste[cand[b]] })
		r.For[o] = idsOf(cand[:min(60, len(cand))])
		far := slices.Clone(cand[max(0, len(cand)-30):])
		slices.Reverse(far)
		r.Surprise[o] = idsOf(far)
	}
	graph, graphSim := make([][]int, len(cross)), make([][]float32, len(cross))
	for i := range cross {
		graph[i], graphSim[i] = append(slices.Clone(txt.idx[i]), cross[i]...), append(slices.Clone(txt.sim[i]), crossSim[i]...)
	}
	r.Bridge = idsOf(bridge(graph, graphSim, from, to))

	monthRows := map[string]*[2][]int{}
	for i, m := range monthOf {
		if monthRows[m] == nil {
			monthRows[m] = &[2][]int{}
		}
		monthRows[m][owner[i]] = append(monthRows[m][owner[i]], i)
	}
	var months []string
	for m := range monthRows {
		months = append(months, m)
	}
	sort.Strings(months)
	r.Sync = pairSync{Months: []string{}, Sim: []float64{}}
	for _, m := range months[max(0, len(months)-24):] {
		if rows := monthRows[m]; len(rows[0]) >= 5 && len(rows[1]) >= 5 {
			r.Sync.Months = append(r.Sync.Months, m)
			r.Sync.Sim = append(r.Sync.Sim, round(cosine(sum(txt.x, rows[0]), sum(txt.x, rows[1]))))
		}
	}
	var moodSim float64
	r.Moods, moodSim = moodsOf(txt.x, owner, monthOf, months[max(0, len(months)-12):], moods)

	weight := wMood
	if r.Moods == nil {
		weight = 0 // the other scores share its weight
	}
	norm := math.Max(0, math.Min(1, (centroid-0.5)/0.45))
	mix := (mixing[0] + mixing[1]) / 2
	r.Scores = pairScores{
		Compat: int(math.Round(100 * (wMixing*mix + wCentroid*norm + weight*moodSim + wHour*hourSim) / (wMixing + wCentroid + weight + wHour))),
		Mixing: round(mix), Centroid: round(centroid), MoodSim: round(moodSim), HourSim: round(hourSim),
	}
	p.report("extras", 1, 1)
	return r
}

// bridge is the cheapest path between two memes on a kNN graph (undirected); the step cost (1 − sim)² prefers
// small steps to one jump. A long path keeps 8 evenly spaced memes with both ends; nil when there is none.
func bridge(idx [][]int, sim [][]float32, from, to int) []int {
	if from < 0 || to < 0 {
		return nil
	}
	type link struct {
		to int
		w  float64
	}
	n := len(idx)
	adj := make([][]link, n)
	for i, ids := range idx {
		for k, j := range ids {
			w := math.Pow(1-float64(sim[i][k]), 2)
			adj[i], adj[j] = append(adj[i], link{j, w}), append(adj[j], link{i, w})
		}
	}
	dist, prev, done := make([]float64, n), make([]int, n), make([]bool, n)
	for i := range dist {
		dist[i], prev[i] = math.Inf(1), -1
	}
	dist[from] = 0
	for u := from; u != to; {
		done[u] = true
		for _, l := range adj[u] {
			if d := dist[u] + l.w; d < dist[l.to] {
				dist[l.to], prev[l.to] = d, u
			}
		}
		u = -1
		for i := range n {
			if !done[i] && !math.IsInf(dist[i], 1) && (u < 0 || dist[i] < dist[u]) {
				u = i
			}
		}
		if u < 0 {
			return nil
		}
	}
	var path []int
	for u := to; u >= 0; u = prev[u] {
		path = append([]int{u}, path...)
	}
	if len(path) <= 8 {
		return path
	}
	out := make([]int, 8)
	for k := range out {
		out[k] = path[k*(len(path)-1)/7]
	}
	return out
}

// moodsOf: each meme's softmax(cos/moodTemp) over the anchors, averaged per owner over the months and all time;
// the similarity is 1 − JSD of the all-time distributions.
func moodsOf(x mat, owner []int, monthOf, months []string, moods []mood) (*pairMoods, float64) {
	for _, m := range moods {
		if len(m.Vector) != x.d {
			return nil, 0
		}
	}
	if len(moods) == 0 || x.n == 0 {
		return nil, 0
	}
	k := len(moods)
	anchors := newMat(k, x.d)
	pm := &pairMoods{Names: map[string][]string{"en": {}, "ru": {}}, Months: months, A: make([][]float64, len(months)),
		B: make([][]float64, len(months)), Sim: make([]*float64, len(months)), Top: [2]int{-1, -1}, Best: []string{}}
	for i, m := range moods {
		copy(anchors.row(i), m.Vector)
		pm.Keys, pm.Emoji = append(pm.Keys, m.Key), append(pm.Emoji, m.Emoji)
		pm.Names["en"], pm.Names["ru"] = append(pm.Names["en"], m.NameEn), append(pm.Names["ru"], m.NameRu)
	}
	normalize(anchors)
	col := map[string]int{}
	for i, m := range months {
		col[m] = i
	}
	rows := [2][][]float64{pm.A, pm.B}
	var total [2]int
	cnt := [2][]int{make([]int, len(months)), make([]int, len(months))}
	add := func(dst *[]float64, p []float64) {
		if *dst == nil {
			*dst = make([]float64, k)
		}
		for j, v := range p {
			(*dst)[j] += v
		}
	}
	for i := range x.n {
		p, top := make([]float64, k), math.Inf(-1)
		for j := range k {
			p[j] = dot(x.row(i), anchors.row(j)) / moodTemp
			top = math.Max(top, p[j])
		}
		s := 0.0
		for j := range p {
			p[j] = math.Exp(p[j] - top)
			s += p[j]
		}
		for j := range p {
			p[j] /= s
		}
		o := owner[i]
		add(&pm.Overall[o], p)
		total[o]++
		if m, ok := col[monthOf[i]]; ok {
			add(&rows[o][m], p)
			cnt[o][m]++
		}
	}
	scale := func(v []float64, n int) {
		for j := range v {
			v[j] = round(v[j] / float64(n))
		}
	}
	for o := range 2 {
		scale(pm.Overall[o], total[o])
		year := make([]float64, k)
		for m, v := range rows[o] {
			if v != nil {
				for j := range v {
					year[j] += v[j] * float64(cnt[o][m])
				}
				scale(v, cnt[o][m])
			}
		}
		if slices.Max(year) > 0 {
			pm.Top[o] = slices.Index(year, slices.Max(year))
		}
	}
	var best []int
	for m := range months {
		if pm.A[m] != nil && pm.B[m] != nil {
			s := round(1 - jsd(pm.A[m], pm.B[m]))
			pm.Sim[m], best = &s, append(best, m)
		}
	}
	sort.SliceStable(best, func(a, b int) bool { return *pm.Sim[best[a]] > *pm.Sim[best[b]] })
	for _, m := range best[:min(3, len(best))] {
		pm.Best = append(pm.Best, months[m])
	}
	if pm.Overall[0] == nil || pm.Overall[1] == nil {
		return pm, 0
	}
	return pm, 1 - jsd(pm.Overall[0], pm.Overall[1])
}

// jsd is the Jensen-Shannon divergence of two distributions in bits (0..1).
func jsd(p, q []float64) float64 {
	d := 0.0
	for i := range p {
		m := (p[i] + q[i]) / 2
		for _, v := range []float64{p[i], q[i]} {
			if v > 0 {
				d += v * math.Log2(v/m) / 2
			}
		}
	}
	return math.Max(0, d)
}

// sum of the rows: the direction of their centroid.
func sum(x mat, rows []int) []float32 {
	out := make([]float32, x.d)
	for _, i := range rows {
		for j, v := range x.row(i) {
			out[j] += v
		}
	}
	return out
}

// cosine of two vectors; 0 when one is zero.
func cosine(a, b []float32) float64 {
	if l := math.Sqrt(dot(a, a) * dot(b, b)); l > 0 {
		return dot(a, b) / l
	}
	return 0
}

// earlier is the owner of the smaller value: 0 for a, 1 for b, -1 when they are equal.
func earlier[T cmp.Ordered](a, b T) int {
	switch {
	case a < b:
		return 0
	case b < a:
		return 1
	}
	return -1
}

// pairCharts are the report PNGs of a pair analysis.
func pairCharts(a *pairAnalytics, r *pairResult) map[string][]byte {
	if a.Lang != "" {
		lang = a.Lang
	}
	out := map[string][]byte{}
	names := [2]string{cmp.Or(a.Me.Name, "A"), cmp.Or(a.Partner.Name, "B")}
	nameOf := func(g cluster) string {
		if g.Name != "" || len(g.Tags) == 0 {
			return g.Name
		}
		return "#" + g.Tags[0]
	}
	if len(r.Map.XY) > 0 {
		twin := map[string]bool{}
		for _, t := range r.Twins {
			twin[fmt.Sprint(t[0])], twin[fmt.Sprint(t[1])] = true, true
		}
		gs := make([]int, len(r.Map.XY))
		for i, id := range r.Map.IDs {
			gs[i] = r.Map.Owner[i]
			if twin[id] {
				gs[i] = 2
			}
		}
		var labels []label
		var items []kv
		for _, g := range r.Clusters {
			if g.Type == "shared" {
				labels = append(labels, label{g.X, g.Y, nameOf(g.cluster)})
				items = append(items, kv{nameOf(g.cluster), float64(g.Size) / float64(len(r.Map.IDs))})
			}
		}
		legend := []series{{names[0], nil, palette[0]}, {names[1], nil, palette[1]}, {tr("twins"), nil, palette[2]}}
		addChart(out, "pair_map", func() []byte { return scatterChart(r.Map.XY, gs, labels, legend) })
		if len(items) > 0 {
			addChart(out, "pair_clusters", func() []byte { return hbars(items, percent) })
		}
	}
	if m := r.Moods; m != nil && m.Overall[0] != nil && m.Overall[1] != nil {
		addChart(out, "pair_moods", func() []byte {
			order := make([]int, len(m.Keys)) // the 8 largest moods of the pair: all their labels fit
			for i := range order {
				order[i] = i
			}
			sort.SliceStable(order, func(x, y int) bool {
				return m.Overall[0][order[x]]+m.Overall[1][order[x]] > m.Overall[0][order[y]]+m.Overall[1][order[y]]
			})
			var xs []string
			ss := []series{{names[0], nil, palette[0]}, {names[1], nil, palette[1]}}
			for _, j := range order[:min(8, len(order))] {
				xs = append(xs, m.Names[lang][j])
				for o := range ss {
					ss[o].values = append(ss[o].values, m.Overall[o][j])
				}
			}
			bars := stackedBars(xs, ss, percent)
			var months []string
			var sim []float64
			for i, s := range m.Sim {
				if s != nil {
					months, sim = append(months, m.Months[i]), append(sim, *s)
				}
			}
			if len(sim) < 2 {
				return bars
			}
			return vstack(lineChart(months, []series{{"", sim, palette[2]}}, percent), bars)
		})
	}
	var hours []series
	for o, side := range [2]pairSide{a.Me, a.Partner} {
		v, total := make([]float64, 24), 0.0
		for _, c := range side.Heatmap {
			v[int(c.H)%24] += c.N
			total += c.N
		}
		for h := range v {
			v[h] /= math.Max(1, total)
		}
		hours = append(hours, series{names[o], v, palette[o]})
	}
	if len(a.Me.Heatmap) > 0 || len(a.Partner.Heatmap) > 0 {
		xs := make([]string, 24)
		for h := range xs {
			xs[h] = fmt.Sprint(h)
		}
		addChart(out, "pair_hours", func() []byte { return lineChart(xs, hours, percent) })
	}
	return out
}
