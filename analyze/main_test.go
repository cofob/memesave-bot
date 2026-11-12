package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"
)

// synthetic: n memes in k blobs; text vectors of every 10th meme are missing, meme 1 repeats meme 0's image.
func synthetic(n, k, d int) ([]meme, map[string][]float32, []int) {
	rng := rand.New(rand.NewPCG(7, 8))
	centers := make([][]float32, k)
	for c := range centers {
		centers[c] = make([]float32, d)
		for j := range d {
			centers[c][j] = float32(rng.NormFloat64())
		}
	}
	vec := func(c int) []float32 {
		v := make([]float32, d)
		for j := range v {
			v[j] = centers[c][j] + float32(rng.NormFloat64()*0.8)
		}
		return v
	}
	memes, vectors, truth := make([]meme, n), map[string][]float32{}, make([]int, n)
	for i := range n {
		c := rng.IntN(k)
		id := fmt.Sprintf("m%d", i)
		truth[i] = c
		memes[i] = meme{ID: id, Kind: "photo", Created: int64(i) * 86400 * 30 / int64(max(1, n/12)), Tags: []string{fmt.Sprintf("c%d", c), fmt.Sprintf("t%d", i%7)}}
		vectors[id+":i"] = vec(c)
		if i%10 != 0 {
			vectors[id+":t"] = vec(c)
		}
	}
	// m1 is a copy of m0's picture (m0 has no description to compare); m2 and m3 are different videos with the
	// same black preview frame: the same picture, different descriptions.
	vectors["m1:i"] = append([]float32(nil), vectors["m0:i"]...)
	if n > 3 {
		vectors["m3:i"] = append([]float32(nil), vectors["m2:i"]...)
	}
	// m10..m60: videos without descriptions sharing one black preview: a placeholder, not 6 copies.
	if n > 60 {
		for k := 20; k <= 60; k += 10 {
			vectors[fmt.Sprintf("m%d:i", k)] = append([]float32(nil), vectors["m10:i"]...)
		}
	}
	return memes, vectors, truth
}

func TestAnalyze(t *testing.T) {
	memes, vectors, truth := synthetic(1500, 5, 256)
	r := analyze(memes, vectors, &progress{})

	groups := r.Clusters
	if len(groups) < 4 || len(groups) > 8 {
		t.Fatalf("clusters: %d", len(groups))
	}
	// Each found cluster is pure: its top tag is its blob, and most members share the blob.
	labels, ids := r.Text.Labels, r.Text.IDs
	for _, g := range groups {
		count := map[int]int{}
		for i, l := range labels {
			if l == g.ID {
				var n int
				fmt.Sscanf(ids[i], "m%d", &n)
				count[truth[n]]++
			}
		}
		best := 0
		for _, c := range count {
			best = max(best, c)
		}
		if float64(best) < 0.9*float64(g.Size) || g.Tags[0][0] != 'c' {
			t.Errorf("impure cluster %+v: %v", g, count)
		}
	}
	dups := r.Duplicates
	if len(dups) != 1 || dups[0][0] != "m0" || dups[0][1] != "m1" {
		t.Errorf("duplicates: only m0 and m1 (m2/m3 differ in text): %v", dups)
	}
	if tags := r.TagMap; len(tags) != 12 {
		t.Errorf("tagmap: %d", len(tags))
	}
	if len(r.Outliers) != 50 || len(r.PCA.Text) != 50 {
		t.Error("outliers or pca")
	}
}

func TestSmall(t *testing.T) {
	for _, n := range []int{0, 1, 2, 10, 40} {
		memes, vectors, _ := synthetic(n, 2, 16)
		analyze(memes, vectors, &progress{})
	}
}

const sampleAnalytics = `{
 "timeline": [{"day":"2026-10-01","kind":"photo","n":5},{"day":"2026-10-03","kind":"video","n":2},{"day":"2026-10-04","kind":"photo","n":9}],
 "saved": [{"day":"2026-09-01","n":3}],
 "heatmap": [{"wd":0,"h":13,"n":4},{"wd":3,"h":22,"n":9}],
 "kinds": [{"k":"photo","n":14},{"k":"video","n":2}], "statuses": [{"k":"ready","n":16}],
 "languages": [{"k":"ru","n":10},{"k":null,"n":6}], "sources": [], "sizes": [{"k":"<1M","n":10}],
 "durations": [{"k":"<15s","n":2}], "aspect": [{"k":"square","n":12}],
 "tags": {"top": [{"tag":"кот","count":9},{"tag":"work 💼","count":4}], "perMeme": [{"tags":8,"n":10}],
   "cooc": {"tags":["кот","work"],"matrix":[[0,3],[3,0]]},
   "trend": {"tags":["кот"],"months":[{"month":"2026-09","counts":{"кот":2}},{"month":"2026-10","counts":{"кот":7}}]}},
 "spend": {"days": [{"day":"2026-10-01","kind":"describe","cost":0.012}], "models": [{"model":"google/gemini","cost":0.01,"n":3,"prompt":1000,"completion":200}],
   "keys": [{"k":"global","cost":0.01}], "perMeme": [{"kind":"describe","per_meme":0.0011}]},
 "albums": [{"size":1,"n":10},{"size":3,"n":2}],
 "stats": {"total": 16}, "lang": "ru",
 "origins": {"kinds": [{"kind":"channel","n":9},{"kind":"direct","n":7}], "top": [{"name":"Мемы","kind":"channel","n":9,"uses":3}],
   "months": [{"month":"2026-09","counts":{"channel":2}},{"month":"2026-10","counts":{"channel":7,"direct":7}}]},
 "added": [{"month":"2026-09","via":"bot","n":2},{"month":"2026-10","via":"web","n":5},{"month":"2026-10","via":"unknown","n":9}],
 "uses": {"days": [{"day":"2026-10-02","via":"inline","n":3},{"day":"2026-10-04","via":"send","n":1}]}
}`

func TestCharts(t *testing.T) {
	memes, vectors, _ := synthetic(600, 4, 64)
	r := analyze(memes, vectors, &progress{})
	r.Analytics = []byte(sampleAnalytics)
	for i := range r.TagMap { // realistic counts for the bubble sizes
		r.TagMap[i].N = 300 / (i + 1)
	}
	r.Clusters[0].Name = "Коты на работе"
	// A render run reads the stored JSON back: the charts must not depend on in-memory types.
	b, _ := json.Marshal(r)
	back := &result{}
	if err := json.Unmarshal(b, back); err != nil {
		t.Fatal(err)
	}
	var a analytics
	if err := json.Unmarshal(back.Analytics, &a); err != nil {
		t.Fatal(err)
	}
	images := charts(&a, back)
	for _, name := range []string{"per_day", "total", "saved", "heatmap", "kinds", "languages", "top_tags", "cooc", "trend", "spend_day", "spend_models", "tokens", "albums", "map_text", "map_image", "tag_map", "similarity", "alignment", "origin_kinds", "top_sources", "origins_month", "uses_day", "interest_trend", "added_via", "added_month", "spend_keys", "pca", "kinds", "statuses", "sizes", "durations", "aspect", "tags_per_meme", "spend_total", "cost_per_meme"} {
		img, err := png.Decode(bytes.NewReader(images[name]))
		if err != nil || img.Bounds().Dx() != width*scale {
			t.Errorf("%s: %v", name, err)
		}
	}
	if dir := os.Getenv("CHARTS_DIR"); dir != "" {
		for name, b := range images {
			_ = os.WriteFile(filepath.Join(dir, name+".png"), b, 0o644)
		}
	}
}

func TestTrends(t *testing.T) {
	// Cluster 0 is all of the first months, cluster 1 all of the last three: 1 rises, 0 fades.
	var memes []meme
	var ids []string
	var labels []int
	for m := range 6 {
		for k := range 10 {
			id := fmt.Sprintf("m%d-%d", m, k)
			memes = append(memes, meme{ID: id, Created: int64(m) * 31 * 86400})
			ids = append(ids, id)
			labels = append(labels, map[bool]int{true: 1, false: 0}[m >= 3])
		}
	}
	tr := interestTrends(memes, ids, labels, 2)
	if len(tr.Months) != 6 || tr.Total[0] != 10 || tr.Clusters[1][5] != 10 {
		t.Fatalf("counts: %+v", tr)
	}
	if fmt.Sprint(tr.Rising, tr.Fading) != "[1] [0]" {
		t.Errorf("rising %v fading %v", tr.Rising, tr.Fading)
	}
}

func TestPeriods(t *testing.T) {
	short := dayRange([]string{"2026-01-01", "2026-01-10"})
	if xs, _ := periods(short, nil); len(xs) != 10 {
		t.Errorf("short range stays daily: %d", len(xs))
	}
	year := dayRange([]string{"2025-01-01", "2025-12-31"})
	xs, rows := periods(year, [][3]any{{"2025-01-08", "a", 1.0}, {"2025-01-12", "a", 2.0}})
	if xs[0] != "2024-12-30" || rows[0][0] != "2025-01-06" || rows[1][0] != "2025-01-06" {
		t.Errorf("weeks start on Monday: %v %v", xs[:2], rows)
	}
	if xs, _ := periods(dayRange([]string{"2023-01-01", "2025-12-31"}), nil); len(xs) != 36 || xs[0] != "2023-01" {
		t.Errorf("long range by month: %d %v", len(xs), xs[:1])
	}
}

// pairSynthetic: synthetic() memes of 5 blobs with owner a in blobs 0–2 and b in blobs 2–4 (blob 2 is a's
// alone unless shared); b re-saves 3 of a's memes (twins). Mood anchors are 5 memes' text vectors.
func pairSynthetic(n int, shared bool) ([]meme, map[string][]float32, []mood) {
	memes, vectors, truth := synthetic(n, 5, 64)
	for i := range memes {
		if truth[i] > 2 || (truth[i] == 2 && shared && i%2 == 1) {
			memes[i].Owner = 1
		}
	}
	if n > 1 {
		memes[1].Owner = memes[0].Owner // synthetic's own copy stays with one owner
	}
	var moods []mood
	for i, copies := 100, 0; i < n; i++ {
		id := memes[i].ID
		if memes[i].Owner == 0 && copies < 3 {
			copies++
			c := meme{ID: "c" + id, Kind: "photo", Created: memes[i].Created + 86400, Tags: memes[i].Tags, Owner: 1}
			memes, vectors[c.ID+":i"], vectors[c.ID+":t"] = append(memes, c), vectors[id+":i"], vectors[id+":t"]
		}
		if v, ok := vectors[id+":t"]; ok && len(moods) < 5 {
			moods = append(moods, mood{Key: id, NameEn: id, NameRu: id, Vector: v})
		}
	}
	return memes, vectors, moods
}

func TestPair(t *testing.T) {
	memes, vectors, moods := pairSynthetic(1500, true)
	r := analyzePair(memes, vectors, moods, 0.5, &progress{})
	sharedBlob := false
	for _, c := range r.Clusters {
		if c.Tags[0] == "c2" {
			sharedBlob = true
			if c.Type != "shared" {
				t.Errorf("blob 2 is shared: %+v", c)
			}
		}
	}
	if !sharedBlob || len(r.Twins) != 3 || len(r.Bridge) < 2 || r.Moods == nil {
		t.Errorf("clusters %d, twins %v, bridge %v", len(r.Clusters), r.Twins, r.Bridge)
	}
	memes, vectors, moods = pairSynthetic(1500, false)
	disjoint := analyzePair(memes, vectors, moods, 0.5, &progress{})
	if r.Scores.Compat <= disjoint.Scores.Compat {
		t.Errorf("compat: overlapping %+v, disjoint %+v", r.Scores, disjoint.Scores)
	}
	images := pairCharts(&pairAnalytics{Lang: "ru", Me: pairSide{Name: "Аня", Heatmap: []struct{ H, N float64 }{{9, 3}, {22, 5}}}}, r)
	for _, name := range []string{"pair_map", "pair_clusters", "pair_moods", "pair_hours"} {
		img, err := png.Decode(bytes.NewReader(images[name]))
		if err != nil || img.Bounds().Dx() != width*scale {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := json.Marshal(r); err != nil {
		t.Error(err)
	}
	if dir := os.Getenv("CHARTS_DIR"); dir != "" {
		for name, b := range images {
			_ = os.WriteFile(filepath.Join(dir, name+".png"), b, 0o644)
		}
	}
	for _, n := range []int{0, 1, 10, 40} {
		memes, vectors, moods := pairSynthetic(2*n, true)
		pairCharts(&pairAnalytics{}, analyzePair(memes, vectors, moods, 0, &progress{}))
	}
}
