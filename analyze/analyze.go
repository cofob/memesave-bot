package main

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"sort"
	"time"
)

const neighbors = 15

// space is one vector kind of the memes that have it: ids, normalized vectors, the PCA and the 2D map.
type space struct {
	ids  []string
	x    mat // normalized full vectors
	pca  pcaModel
	p    mat // normalized PCA coordinates (kNN and the graph use them)
	idx  [][]int
	sim  [][]float32
	xy   [][2]float64
	xyz  [][3]float64 // the 3D map for the web
	edge []edge
}

func newSpace(memes []meme, vectors map[string][]float32, suffix string) *space {
	s := &space{ids: []string{}}
	var rows [][]float32
	for _, m := range memes {
		if v, ok := vectors[m.ID+suffix]; ok && len(v) > 0 && (len(rows) == 0 || len(v) == len(rows[0])) {
			s.ids, rows = append(s.ids, m.ID), append(rows, v)
		}
	}
	if len(rows) == 0 {
		return s
	}
	s.x = newMat(len(rows), len(rows[0]))
	for i, r := range rows {
		copy(s.x.row(i), r)
	}
	normalize(s.x)
	return s
}

// project fits the PCA, the kNN graph and the 2D map; small sets use the first PCA components only.
func (s *space) project() {
	n := len(s.ids)
	s.xy = make([][2]float64, n)
	if n < 3 {
		return
	}
	s.pca = pca(s.x, 50)
	p := s.pca.transform(s.x)
	for i := range n {
		s.xy[i][0] = float64(p.row(i)[0])
		if p.d > 1 {
			s.xy[i][1] = float64(p.row(i)[1])
		}
	}
	s.p = normalize(p)
	s.idx, s.sim = knn(s.p, neighbors)
	if n < 20 {
		return
	}
	s.edge = fuzzyGraph(s.idx, s.sim)
	init := func(dim int) [][]float64 {
		out := make([][]float64, n)
		for i := range n {
			out[i] = make([]float64, dim)
			for d := range min(dim, p.d) {
				out[i][d] = float64(p.row(i)[d])
			}
		}
		return out
	}
	for i, q := range layout(s.edge, init(2)) {
		s.xy[i] = [2]float64{q[0], q[1]}
	}
	s.xyz = make([][3]float64, n)
	for i, q := range layout(s.edge, init(3)) {
		s.xyz[i] = [3]float64{round(q[0]), round(q[1]), round(q[2])}
	}
}

// place puts new vectors on the map: the similarity-weighted mean of their nearest points (UMAP's transform init).
func (s *space) place(x mat) [][2]float64 {
	p := normalize(s.pca.transform(x))
	out := make([][2]float64, x.n)
	for i := range x.n {
		type hit struct {
			j int
			s float64
		}
		var top []hit
		for j := range s.p.n {
			top = append(top, hit{j, dot(p.row(i), s.p.row(j))})
		}
		sort.Slice(top, func(a, b int) bool { return top[a].s > top[b].s })
		var w float64
		for _, h := range top[:min(neighbors, len(top))] {
			hw := math.Max(h.s, 1e-6)
			out[i][0] += s.xy[h.j][0] * hw
			out[i][1] += s.xy[h.j][1] * hw
			w += hw
		}
		out[i][0], out[i][1] = out[i][0]/w, out[i][1]/w
	}
	return out
}

type cluster struct {
	ID      int      `json:"id"`
	Size    int      `json:"size"`
	X       float64  `json:"x"`
	Y       float64  `json:"y"`
	Tags    []string `json:"tags"`
	Sample  []string `json:"sample"`
	Name    string   `json:"name,omitempty"` // LLM name and summary, set by the Worker
	Summary string   `json:"summary,omitempty"`
}

// clusters are Louvain communities of the text graph; small ones are noise (-1).
// Per cluster: size, center on the map, c-TF-IDF tags, the memes nearest to the center.
func clusters(s *space, tagsOf map[string][]string) ([]int, []cluster) {
	n := len(s.ids)
	labels := make([]int, n)
	for i := range labels {
		labels[i] = -1
	}
	if n < 50 || len(s.edge) == 0 {
		return labels, []cluster{}
	}
	comm := louvain(n, s.edge)
	members := map[int][]int{}
	for i, c := range comm {
		members[c] = append(members[c], i)
	}
	var groups [][]int
	for _, m := range members {
		if len(m) >= max(5, n/200) {
			groups = append(groups, m)
		}
	}
	sort.Slice(groups, func(a, b int) bool { return len(groups[a]) > len(groups[b]) })
	df := map[string]int{}
	for _, id := range s.ids {
		for _, t := range tagsOf[id] {
			df[t]++
		}
	}
	out := []cluster{}
	for c, g := range groups {
		center := make([]float32, s.x.d)
		tf := map[string]int{}
		cl := cluster{ID: c, Size: len(g)}
		for _, i := range g {
			labels[i] = c
			for j, v := range s.x.row(i) {
				center[j] += v
			}
			cl.X += s.xy[i][0] / float64(len(g))
			cl.Y += s.xy[i][1] / float64(len(g))
			for _, t := range tagsOf[s.ids[i]] {
				tf[t]++
			}
		}
		near := append([]int(nil), g...)
		sort.Slice(near, func(a, b int) bool { return dot(s.x.row(near[a]), center) > dot(s.x.row(near[b]), center) })
		for _, i := range near[:min(8, len(near))] {
			cl.Sample = append(cl.Sample, s.ids[i])
		}
		score := map[string]float64{}
		for t, k := range tf {
			score[t] = float64(k) / float64(len(g)) * math.Log(float64(n)/float64(df[t]))
		}
		cl.Tags = topKeys(score, 8)
		cl.X, cl.Y = round(cl.X), round(cl.Y)
		out = append(out, cl)
	}
	return labels, out
}

func topKeys(score map[string]float64, k int) []string {
	keys := make([]string, 0, len(score))
	for t := range score {
		keys = append(keys, t)
	}
	sort.Slice(keys, func(a, b int) bool {
		return score[keys[a]] > score[keys[b]] || (score[keys[a]] == score[keys[b]] && keys[a] < keys[b])
	})
	return keys[:min(k, len(keys))]
}

// duplicates are near-identical images the sha256 dedupe missed (re-encoded, resized, cropped):
// kNN candidates, checked on the full vectors. Two guards against a placeholder picture (a black first frame
// of a video, a blank cover): when both memes have descriptions, they must match too; and a picture with many
// identical neighbours is a placeholder, not a meme with copies.
func duplicates(s, text *space) [][3]any {
	const same, placeholder = 0.995, 4 // 4+ identical neighbours: a placeholder
	twins := make([]int, len(s.ids))
	for i, ids := range s.idx {
		for _, j := range ids {
			if dot(s.x.row(i), s.x.row(j)) >= same {
				twins[i]++
			}
		}
	}
	textOf := map[string]int{}
	for i, id := range text.ids {
		textOf[id] = i
	}
	sameText := func(a, b string) bool {
		ta, okA := textOf[a]
		tb, okB := textOf[b]
		return !okA || !okB || dot(text.x.row(ta), text.x.row(tb)) >= 0.9
	}
	type pair struct {
		a, b int
		s    float64
	}
	seen := map[[2]int]bool{}
	var pairs []pair
	for i, ids := range s.idx {
		for _, j := range ids[:min(5, len(ids))] {
			a, b := min(i, j), max(i, j)
			if seen[[2]int{a, b}] {
				continue
			}
			seen[[2]int{a, b}] = true
			if twins[a] >= placeholder || twins[b] >= placeholder {
				continue
			}
			if sim := dot(s.x.row(a), s.x.row(b)); sim >= 0.97 && sameText(s.ids[a], s.ids[b]) {
				pairs = append(pairs, pair{a, b, sim})
			}
		}
	}
	sort.Slice(pairs, func(a, b int) bool { return pairs[a].s > pairs[b].s })
	out := [][3]any{}
	for _, p := range pairs[:min(200, len(pairs))] {
		out = append(out, [3]any{s.ids[p.a], s.ids[p.b], math.Round(p.s*1e4) / 1e4})
	}
	return out
}

// outliers are the memes least like any other: lowest similarity to their 6th nearest neighbor.
func outliers(s *space) []string {
	const k = 6
	var idx []int
	for i, sim := range s.sim {
		if len(sim) >= k {
			idx = append(idx, i)
		}
	}
	sort.Slice(idx, func(a, b int) bool { return s.sim[idx[a]][k-1] < s.sim[idx[b]][k-1] })
	out := []string{}
	for _, i := range idx[:min(50, len(idx))] {
		out = append(out, s.ids[i])
	}
	return out
}

type histogram struct {
	Edges  []float64 `json:"edges"`
	Counts []int     `json:"counts"`
}

func hist(v []float64, bins int) histogram {
	if len(v) == 0 {
		return histogram{Edges: []float64{}, Counts: []int{}}
	}
	lo, hi := v[0], v[0]
	for _, x := range v {
		lo, hi = math.Min(lo, x), math.Max(hi, x)
	}
	return histRange(v, lo, hi, bins)
}

// histRange counts v in bins over [lo, hi]; values outside go to the edge bins.
func histRange(v []float64, lo, hi float64, bins int) histogram {
	h := histogram{Edges: []float64{}, Counts: []int{}}
	if len(v) == 0 {
		return h
	}
	if hi == lo {
		hi = lo + 1e-6
	}
	h.Counts = make([]int, bins)
	for i := range bins + 1 {
		h.Edges = append(h.Edges, math.Round((lo+(hi-lo)*float64(i)/float64(bins))*1e4)/1e4)
	}
	for _, x := range v {
		h.Counts[max(0, min(bins-1, int((x-lo)/(hi-lo)*float64(bins))))]++
	}
	return h
}

// randomPairs is the similarity of random meme pairs: how alike the collection is overall.
func randomPairs(x mat) []float64 {
	if x.n < 2 {
		return nil
	}
	rng := rand.New(rand.NewPCG(5, 6))
	out := make([]float64, 0, 20000)
	for range 20000 {
		a, b := rng.IntN(x.n), rng.IntN(x.n)
		if a != b {
			out = append(out, dot(x.row(a), x.row(b)))
		}
	}
	return out
}

type tagPoint struct {
	Tag string  `json:"tag"`
	X   float64 `json:"x"`
	Y   float64 `json:"y"`
	N   int     `json:"n"`
}

// tagMap places the top tags on the text map by the centroid of their memes.
func tagMap(s *space, tagsOf map[string][]string) []tagPoint {
	out := []tagPoint{}
	if len(s.edge) == 0 {
		return out
	}
	members := map[string][]int{}
	for i, id := range s.ids {
		for _, t := range tagsOf[id] {
			members[t] = append(members[t], i)
		}
	}
	score := map[string]float64{}
	for t, m := range members {
		if len(m) >= 3 {
			score[t] = float64(len(m))
		}
	}
	top := topKeys(score, 100)
	if len(top) == 0 {
		return out
	}
	c := newMat(len(top), s.x.d)
	for i, t := range top {
		r := c.row(i)
		for _, j := range members[t] {
			for d, v := range s.x.row(j) {
				r[d] += v
			}
		}
	}
	for i, p := range s.place(normalize(c)) {
		out = append(out, tagPoint{top[i], round(p[0]), round(p[1]), len(members[top[i]])})
	}
	return out
}

func round(v float64) float64 { return math.Round(v*1000) / 1000 }

func coords(xy [][2]float64) [][2]float64 {
	out := make([][2]float64, len(xy))
	for i, p := range xy {
		out[i] = [2]float64{round(p[0]), round(p[1])}
	}
	return out
}

func ratios(p pcaModel) []float64 {
	out := []float64{}
	for _, r := range p.ratio {
		out = append(out, math.Round(r*1e5)/1e5)
	}
	return out
}

// result is the analysis JSON (src/analysis.ts, app/src/api.ts AnalysisResult). A render run reads it back.
type result struct {
	CreatedAt int64     `json:"created_at"`
	Count     int       `json:"count"`
	Memes     [][4]any  `json:"memes"`
	Image     mapOut    `json:"image"`
	Text      mapOut    `json:"text"`
	Clusters  []cluster `json:"clusters"`
	PCA       struct {
		Image []float64 `json:"image"`
		Text  []float64 `json:"text"`
	} `json:"pca"`
	Duplicates [][3]any `json:"duplicates"`
	Outliers   []string `json:"outliers"`
	Alignment  struct {
		Hist  histogram `json:"hist"`
		Worst [][2]any  `json:"worst"`
	} `json:"alignment"`
	Similarity struct {
		Image histogram `json:"image"`
		Text  histogram `json:"text"`
	} `json:"similarity"`
	TagMap    []tagPoint      `json:"tagmap"`
	Trends    trends          `json:"trends"`
	Analytics json.RawMessage `json:"analytics,omitempty"` // the SQL stats snapshot (GET /analytics)
	Images    []string        `json:"images"`
}

type mapOut struct {
	IDs    []string     `json:"ids"`
	XY     [][2]float64 `json:"xy"`
	XYZ    [][3]float64 `json:"xyz,omitempty"`    // 3D map (web only)
	Labels []int        `json:"labels,omitempty"` // text clusters, -1: none
}

// trends are the interests over time: memes per month in each of the 8 largest clusters, the rest, and
// all memes; rising and fading are clusters whose share of the last 3 months grew or fell the most.
type trends struct {
	Months   []string `json:"months"`
	Clusters [][]int  `json:"clusters"` // [cluster id][month]
	Other    []int    `json:"other"`
	Total    []int    `json:"total"`
	Rising   []int    `json:"rising"`
	Fading   []int    `json:"fading"`
}

func interestTrends(memes []meme, ids []string, labels []int, groups int) trends {
	created := map[string]int64{}
	for _, m := range memes {
		created[m.ID] = m.Created
	}
	month := func(id string) string { return time.Unix(created[id], 0).UTC().Format("2006-01") }
	seen := map[string]bool{}
	t := trends{Months: []string{}, Clusters: [][]int{}, Rising: []int{}, Fading: []int{}}
	for _, id := range ids {
		if m := month(id); !seen[m] {
			seen[m] = true
			t.Months = append(t.Months, m)
		}
	}
	sort.Strings(t.Months)
	pos := map[string]int{}
	for i, m := range t.Months {
		pos[m] = i
	}
	top := min(groups, len(palette))
	counts := make([][]int, groups) // every cluster, for rising and fading
	for c := range counts {
		counts[c] = make([]int, len(t.Months))
	}
	t.Other, t.Total = make([]int, len(t.Months)), make([]int, len(t.Months))
	for i, id := range ids {
		m := pos[month(id)]
		t.Total[m]++
		if l := labels[i]; l >= 0 {
			counts[l][m]++
			if l >= top {
				t.Other[m]++
			}
		}
	}
	t.Clusters = counts[:top]
	if len(t.Months) < 4 {
		return t
	}
	split := len(t.Months) - 3
	share := func(v []int, from, to int) float64 {
		n, all := 0, 0
		for m := from; m < to; m++ {
			n, all = n+v[m], all+t.Total[m]
		}
		return float64(n) / math.Max(1, float64(all))
	}
	diff := make([]float64, groups)
	order := make([]int, groups)
	for c, v := range counts {
		diff[c], order[c] = share(v, split, len(t.Months))-share(v, 0, split), c
	}
	sort.Slice(order, func(a, b int) bool { return diff[order[a]] > diff[order[b]] })
	for _, c := range order[:min(3, len(order))] {
		if diff[c] > 0.02 {
			t.Rising = append(t.Rising, c)
		}
	}
	for i := len(order) - 1; i >= max(0, len(order)-3); i-- {
		if c := order[i]; diff[c] < -0.02 {
			t.Fading = append(t.Fading, c)
		}
	}
	return t
}

// analyze builds the result from the memes and their vectors.
func analyze(memes []meme, vectors map[string][]float32, p *progress) *result {
	tagsOf := map[string][]string{}
	r := &result{CreatedAt: time.Now().Unix(), Count: len(memes), Memes: make([][4]any, len(memes)), Images: []string{}}
	for i, m := range memes {
		tagsOf[m.ID] = m.Tags
		r.Memes[i] = [4]any{m.ID, m.Kind, m.Created, m.Lang}
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

	p.report("extras", 0, 2)
	pos := map[string]int{}
	for i, id := range img.ids {
		pos[id] = i
	}
	var align []float64
	var alignIDs []string
	for t, id := range txt.ids {
		if i, ok := pos[id]; ok {
			align = append(align, dot(txt.x.row(t), img.x.row(i)))
			alignIDs = append(alignIDs, id)
		}
	}
	order := make([]int, len(align))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool { return align[order[a]] < align[order[b]] })
	r.Alignment.Worst = [][2]any{}
	for _, i := range order[:min(30, len(order))] {
		r.Alignment.Worst = append(r.Alignment.Worst, [2]any{alignIDs[i], math.Round(align[i]*1e4) / 1e4})
	}
	r.Alignment.Hist = hist(align, 40)
	p.report("extras", 1, 2)
	r.TagMap = tagMap(txt, tagsOf)
	p.report("extras", 2, 2)

	r.Image = mapOut{IDs: img.ids, XY: coords(img.xy), XYZ: img.xyz}
	r.Text = mapOut{IDs: txt.ids, XY: coords(txt.xy), XYZ: txt.xyz, Labels: labels}
	r.Clusters = groups
	r.Trends = interestTrends(memes, txt.ids, labels, len(groups))
	r.PCA.Image, r.PCA.Text = ratios(img.pca), ratios(txt.pca)
	r.Duplicates = duplicates(img, txt)
	r.Outliers = outliers(txt)
	// One range for both spaces, so the web and the report draw them on one axis.
	r.Similarity.Image, r.Similarity.Text = histRange(randomPairs(img.x), -0.2, 1, 48), histRange(randomPairs(txt.x), -0.2, 1, 48)
	return r
}
