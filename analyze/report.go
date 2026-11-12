package main

import (
	"fmt"
	"log"
	"math"
	"sort"
	"time"
)

// analytics is the part of GET /analytics (src/analytics.ts userAnalytics) that the charts use.
type analytics struct {
	Timeline []struct {
		Day, Kind string
		N         float64
	} `json:"timeline"`
	Saved []struct {
		Day string
		N   float64
	} `json:"saved"`
	Heatmap                                              []struct{ Wd, H, N float64 } `json:"heatmap"`
	Kinds, Statuses, Languages, Sizes, Durations, Aspect []count
	Tags                                                 struct {
		Top []struct {
			Tag   string
			Count float64
		} `json:"top"`
		PerMeme []struct{ Tags, N float64 } `json:"perMeme"`
		Cooc    struct {
			Tags   []string
			Matrix [][]float64
		} `json:"cooc"`
		Trend struct {
			Tags   []string
			Months []struct {
				Month  string
				Counts map[string]float64
			}
		} `json:"trend"`
	} `json:"tags"`
	Spend struct {
		Days []struct {
			Day, Kind string
			Cost      float64
		} `json:"days"`
		Models []struct {
			Model                       string
			Cost, N, Prompt, Completion float64
		} `json:"models"`
		Keys []struct {
			K    string
			Cost float64
		} `json:"keys"`
		PerMeme []struct {
			Kind    string
			PerMeme float64 `json:"per_meme"`
		} `json:"perMeme"`
	} `json:"spend"`
	Albums  []struct{ Size, N float64 } `json:"albums"`
	Lang    string                      `json:"lang"`
	Origins struct {
		Kinds []struct {
			Kind string
			N    float64
		} `json:"kinds"`
		Top []struct {
			Name, Kind string
			N, Uses    float64
		} `json:"top"`
		Months []struct {
			Month  string
			Counts map[string]float64
		} `json:"months"`
	} `json:"origins"`
	Added []struct {
		Month, Via string
		N          float64
	} `json:"added"`
	Uses struct {
		Days []struct {
			Day, Via string
			N        float64
		} `json:"days"`
	} `json:"uses"`
}

type count struct {
	K *string
	N float64
}

func (c count) name() string {
	if c.K == nil {
		return "—"
	}
	return *c.K
}

// dayRange is every day from the first to the last one.
func dayRange(days []string) []string {
	if len(days) == 0 {
		return nil
	}
	sorted := append([]string(nil), days...)
	sort.Strings(sorted)
	from, err1 := time.Parse("2006-01-02", sorted[0])
	to, err2 := time.Parse("2006-01-02", sorted[len(sorted)-1])
	if err1 != nil || err2 != nil {
		return sorted
	}
	var out []string
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

// stack builds series per group over xs: the 7 largest groups in palette order, the rest as "other".
// fixed groups (meme kinds) keep their slots whatever their size: color follows the entity, not its rank.
func stack(xs []string, rows [][3]any, fixed ...string) []series {
	pos := map[string]int{}
	for i, x := range xs {
		pos[x] = i
	}
	total := map[string]float64{}
	for _, r := range rows {
		total[r[1].(string)] += r[2].(float64)
	}
	names := topKeys(total, len(total))
	if len(fixed) > 0 {
		names = fixed
	}
	keep := map[string]int{}
	var out []series
	for i, n := range names[:min(7, len(names))] {
		keep[n] = i
		col := palette[i]
		if n == "unknown" {
			col = other // not recorded: no identity color
		}
		out = append(out, series{tr(n), make([]float64, len(xs)), col})
	}
	if len(names) > 7 {
		out = append(out, series{tr("other"), make([]float64, len(xs)), other})
	}
	for _, r := range rows {
		i, ok := pos[r[0].(string)]
		if !ok {
			continue
		}
		s, ok := keep[r[1].(string)]
		if !ok {
			s = len(out) - 1
		}
		out[s].values[i] += r[2].(float64)
	}
	// Fixed groups without data stay out of the legend (their slots, and so the colors, do not move).
	used := out[:0:0]
	for _, s := range out {
		for _, v := range s.values {
			if v != 0 {
				used = append(used, s)
				break
			}
		}
	}
	return used
}

func cumulative(ss []series) []float64 {
	if len(ss) == 0 {
		return nil
	}
	out := make([]float64, len(ss[0].values))
	sum := 0.0
	for i := range out {
		for _, s := range ss {
			sum += s.values[i]
		}
		out[i] = sum
	}
	return out
}

func counts(cs []count) []kv {
	out := make([]kv, len(cs))
	for i, c := range cs {
		out[i] = kv{tr(c.name()), c.N}
	}
	return out
}

// ordered puts bucket counts in a fixed order (histograms of sizes, lengths, shapes).
func ordered(cs []count, order []string) ([]string, []series) {
	vals := make([]float64, len(order))
	for _, c := range cs {
		for i, o := range order {
			if c.name() == o {
				vals[i] = c.N
			}
		}
	}
	return order, []series{{"", vals, palette[0]}}
}

func hist2(h histogram) ([]string, []series) {
	xs := make([]string, len(h.Counts))
	vals := make([]float64, len(h.Counts))
	for i, c := range h.Counts {
		xs[i] = fmt.Sprintf("%.2f", (h.Edges[i]+h.Edges[i+1])/2)
		vals[i] = float64(c)
	}
	return xs, []series{{"", vals, palette[0]}}
}

// charts renders every chart of the report (SQL stats and the embedding analysis); empty data is skipped.
func charts(a *analytics, r *result) map[string][]byte {
	if a != nil && a.Lang != "" {
		lang = a.Lang
	}
	out := map[string][]byte{}
	add := func(name string, f func() []byte) { addChart(out, name, f) }

	if a != nil && len(a.Timeline) > 0 {
		var days []string
		var rows [][3]any
		for _, t := range a.Timeline {
			days, rows = append(days, t.Day), append(rows, [3]any{t.Day, t.Kind, t.N})
		}
		xs, rows := periods(dayRange(days), rows)
		perDay := stack(xs, rows, "photo", "video", "animation")
		add("per_day", func() []byte { return stackedBars(xs, perDay, number) })
		add("total", func() []byte { return lineChart(xs, []series{{"", cumulative(perDay), palette[0]}}, number) })
	}
	if a != nil && len(a.Saved) > 0 {
		var days []string
		var rows [][3]any
		for _, t := range a.Saved {
			days, rows = append(days, t.Day), append(rows, [3]any{t.Day, "saved", t.N})
		}
		xs, rows := periods(dayRange(days), rows)
		add("saved", func() []byte { return stackedBars(xs, stack(xs, rows), number) })
	}
	if a != nil && len(a.Heatmap) > 0 {
		cells := zeros(7, 24)
		for _, c := range a.Heatmap {
			cells[(int(c.Wd)+6)%7][int(c.H)] = c.N // SQLite %w: 0 = Sunday; rows start on Monday
		}
		hours := make([]string, 24)
		for h := range hours {
			hours[h] = fmt.Sprint(h)
		}
		add("heatmap", func() []byte {
			return heatmapChart(hours, []string{tr("Mon"), tr("Tue"), tr("Wed"), tr("Thu"), tr("Fri"), tr("Sat"), tr("Sun")}, cells)
		})
	}
	if a != nil {
		for name, cs := range map[string][]count{"kinds": a.Kinds, "statuses": a.Statuses, "languages": a.Languages} {
			if len(cs) > 0 {
				add(name, func() []byte { return hbars(counts(cs), number) })
			}
		}
		for name, b := range map[string]struct {
			cs    []count
			order []string
		}{
			"sizes":     {a.Sizes, []string{"<100K", "<500K", "<1M", "<5M", "<20M", "20M+"}},
			"durations": {a.Durations, []string{"<5s", "<15s", "<30s", "<1m", "<3m", "3m+"}},
			"aspect":    {a.Aspect, []string{"portrait", "square", "landscape", "wide"}},
		} {
			if len(b.cs) > 0 {
				add(name, func() []byte { xs, ss := ordered(b.cs, b.order); return stackedBars(xs, ss, number) })
			}
		}
		if len(a.Albums) > 0 {
			xs, vals := []string{}, []float64{}
			for _, al := range a.Albums {
				xs, vals = append(xs, number(al.Size)), append(vals, al.N)
			}
			add("albums", func() []byte { return stackedBars(xs, []series{{"", vals, palette[0]}}, number) })
		}
		if len(a.Tags.Top) > 0 {
			var items []kv
			for _, t := range a.Tags.Top[:min(20, len(a.Tags.Top))] {
				items = append(items, kv{"#" + t.Tag, t.Count})
			}
			add("top_tags", func() []byte { return hbars(items, number) })
		}
		if len(a.Tags.Cooc.Tags) > 1 {
			n := min(16, len(a.Tags.Cooc.Tags)) // readable labels
			cells := zeros(n, n)
			for i := range n {
				copy(cells[i], a.Tags.Cooc.Matrix[i][:n])
			}
			add("cooc", func() []byte { return heatmapChart(a.Tags.Cooc.Tags[:n], a.Tags.Cooc.Tags[:n], cells) })
		}
		if len(a.Tags.Trend.Months) > 1 {
			var months []string
			for _, m := range a.Tags.Trend.Months {
				months = append(months, m.Month)
			}
			var ss []series
			for i, t := range a.Tags.Trend.Tags {
				vals := make([]float64, len(months))
				for j, m := range a.Tags.Trend.Months {
					vals[j] = m.Counts[t]
				}
				ss = append(ss, series{t, vals, palette[i%len(palette)]})
			}
			add("trend", func() []byte { return lineChart(months, ss, number) })
		}
		if len(a.Tags.PerMeme) > 0 {
			xs, vals := []string{}, []float64{}
			for _, p := range a.Tags.PerMeme {
				xs, vals = append(xs, number(p.Tags)), append(vals, p.N)
			}
			add("tags_per_meme", func() []byte { return stackedBars(xs, []series{{"", vals, palette[0]}}, number) })
		}
		if len(a.Spend.Days) > 0 {
			var days []string
			var rows [][3]any
			for _, d := range a.Spend.Days {
				days, rows = append(days, d.Day), append(rows, [3]any{d.Day, d.Kind, d.Cost})
			}
			xs, rows := periods(dayRange(days), rows)
			spend := stack(xs, rows)
			add("spend_day", func() []byte { return stackedBars(xs, spend, money) })
			add("spend_total", func() []byte { return lineChart(xs, []series{{"", cumulative(spend), palette[0]}}, money) })
		}
		if len(a.Spend.Models) > 0 {
			var cost, tokens []kv
			for _, m := range a.Spend.Models {
				cost, tokens = append(cost, kv{m.Model, m.Cost}), append(tokens, kv{m.Model, m.Prompt + m.Completion})
			}
			add("spend_models", func() []byte { return hbars(cost, money) })
			add("tokens", func() []byte { return hbars(tokens, number) })
		}
		if len(a.Spend.PerMeme) > 0 {
			var items []kv
			for _, p := range a.Spend.PerMeme {
				items = append(items, kv{p.Kind, p.PerMeme})
			}
			add("cost_per_meme", func() []byte { return hbars(items, money) })
		}
		if len(a.Spend.Keys) > 0 {
			var items []kv
			for _, k := range a.Spend.Keys {
				items = append(items, kv{tr("key_" + k.K), k.Cost})
			}
			add("spend_keys", func() []byte { return hbars(items, money) })
		}

	}

	if a != nil && len(a.Origins.Kinds) > 0 {
		var kinds []kv
		for _, k := range a.Origins.Kinds {
			kinds = append(kinds, kv{tr(k.Kind), k.N})
		}
		add("origin_kinds", func() []byte { return hbars(kinds, number) })
		if len(a.Origins.Top) > 0 {
			var top []kv
			for _, o := range a.Origins.Top[:min(15, len(a.Origins.Top))] {
				top = append(top, kv{o.Name, o.N})
			}
			add("top_sources", func() []byte { return hbars(top, number) })
		}
		if len(a.Origins.Months) > 1 {
			var months []string
			var rows [][3]any
			for _, m := range a.Origins.Months {
				months = append(months, m.Month)
				for k, n := range m.Counts {
					rows = append(rows, [3]any{m.Month, k, n})
				}
			}
			add("origins_month", func() []byte { return stackedBars(months, stack(months, rows, originOrder...), number) })
		}
	}
	if a != nil && len(a.Added) > 0 {
		var months []string
		var rows [][3]any
		total := map[string]float64{}
		for _, r := range a.Added {
			months, rows = append(months, r.Month), append(rows, [3]any{r.Month, r.Via, r.N})
			total[r.Via] += r.N
		}
		var items []kv
		for _, v := range viaOrder {
			if total[v] > 0 {
				items = append(items, kv{tr(v), total[v]})
			}
		}
		add("added_via", func() []byte { return hbars(items, number) })
		months = uniqueSorted(months)
		if len(months) > 1 {
			add("added_month", func() []byte { return stackedBars(months, stack(months, rows, viaOrder...), number) })
		}
	}
	if a != nil && len(a.Uses.Days) > 0 {
		var days []string
		var rows [][3]any
		for _, d := range a.Uses.Days {
			days, rows = append(days, d.Day), append(rows, [3]any{d.Day, d.Via, d.N})
		}
		xs, rows := periods(dayRange(days), rows)
		add("uses_day", func() []byte { return stackedBars(xs, stack(xs, rows, "inline", "share", "send"), number) })
	}
	if t := r.Trends; len(t.Months) > 1 && len(t.Clusters) > 0 {
		add("interest_trend", func() []byte { return stackedBars(t.Months, trendSeries(t, r.Clusters), percent) })
	}

	// Embedding analysis: maps colored by the text clusters (the 8 largest); labels are the LLM names or the
	// cluster numbers of the report table.
	color := func(l int) int {
		if l < 0 || l >= len(palette) {
			return -1
		}
		return l
	}
	var centers []label
	for _, g := range r.Clusters {
		name := fmt.Sprint(g.ID + 1)
		if g.Name != "" && g.ID < len(palette) {
			name = fmt.Sprintf("%d. %s", g.ID+1, g.Name)
		}
		centers = append(centers, label{g.X, g.Y, name})
	}
	if len(r.Text.XY) > 0 {
		gs := make([]int, len(r.Text.XY))
		for i := range gs {
			gs[i] = -1
			if i < len(r.Text.Labels) {
				gs[i] = color(r.Text.Labels[i])
			}
		}
		add("map_text", func() []byte { return scatterChart(r.Text.XY, gs, centers, nil) })
	}
	if len(r.Image.XY) > 0 {
		byID := map[string]int{}
		for i, id := range r.Text.IDs {
			if i < len(r.Text.Labels) {
				byID[id] = r.Text.Labels[i]
			}
		}
		gs := make([]int, len(r.Image.XY))
		for i, id := range r.Image.IDs {
			gs[i] = -1
			if l, ok := byID[id]; ok {
				gs[i] = color(l)
			}
		}
		add("map_image", func() []byte { return scatterChart(r.Image.XY, gs, nil, nil) })
	}
	if len(r.TagMap) > 0 {
		add("tag_map", func() []byte { return bubbleChart(r.TagMap) })
	}
	if len(r.Similarity.Text.Counts) > 0 || len(r.Similarity.Image.Counts) > 0 {
		add("similarity", func() []byte {
			var ss []series
			var xs []string
			for k, h := range []histogram{r.Similarity.Text, r.Similarity.Image} {
				if len(h.Counts) == 0 {
					continue
				}
				x, s := hist2(h)
				xs, s[0].name, s[0].color = x, tr([]string{"text", "image"}[k]), palette[k]
				ss = append(ss, s[0])
			}
			return lineChart(xs, ss, number)
		})
	}
	if len(r.PCA.Text) > 1 || len(r.PCA.Image) > 1 {
		add("pca", func() []byte {
			var ss []series
			var xs []string
			for k, v := range [][]float64{r.PCA.Text, r.PCA.Image} {
				if len(v) == 0 {
					continue
				}
				sum, cum := 0.0, make([]float64, len(v))
				for i, x := range v {
					sum += x
					cum[i] = sum
				}
				xs = make([]string, len(v))
				for i := range v {
					xs[i] = fmt.Sprint(i + 1)
				}
				ss = append(ss, series{tr([]string{"text", "image"}[k]), cum, palette[k]})
			}
			return lineChart(xs, ss, percent)
		})
	}
	if al := r.Alignment.Hist; len(al.Counts) > 0 {
		add("alignment", func() []byte { xs, ss := hist2(al); return stackedBars(xs, ss, number) })
	}
	return out
}

// addChart draws out[name]; a chart that panics is logged and left out.
func addChart(out map[string][]byte, name string, f func() []byte) {
	defer func() {
		if e := recover(); e != nil {
			log.Printf("chart %s: %v", name, e)
		}
	}()
	out[name] = f()
}

var originOrder = []string{"channel", "group", "user", "link", "direct"}

func percent(v float64) string { return fmt.Sprintf("%.0f%%", v*100) }

// trendSeries is the share of each large cluster (and the rest) in the memes of each month.
func trendSeries(t trends, groups []cluster) []series {
	share := func(v []int) []float64 {
		out := make([]float64, len(v))
		for m, n := range v {
			out[m] = float64(n) / math.Max(1, float64(t.Total[m]))
		}
		return out
	}
	var ss []series
	for c, v := range t.Clusters {
		name := fmt.Sprint(c + 1)
		if c < len(groups) && groups[c].Name != "" {
			name = fmt.Sprintf("%d. %s", c+1, groups[c].Name)
		}
		ss = append(ss, series{name, share(v), palette[c%len(palette)]})
	}
	return append(ss, series{tr("other"), share(t.Other), other})
}

var viaOrder = []string{"bot", "web", "miniapp", "api", "mcp", "zip", "pair", "unknown"}

func uniqueSorted(v []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range v {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

// periods sums a long day range by week (up to 2 years, keyed by the Monday) or month ("2006-01"): hundreds of
// thin daily bars are only noise.
func periods(xs []string, rows [][3]any) ([]string, [][3]any) {
	if len(xs) <= 120 {
		return xs, rows
	}
	key := func(day string) string {
		t, err := time.Parse("2006-01-02", day)
		if err != nil || len(xs) > 730 {
			return day[:min(7, len(day))]
		}
		return t.AddDate(0, 0, -(int(t.Weekday())+6)%7).Format("2006-01-02")
	}
	var out []string
	seen := map[string]bool{}
	for _, x := range xs {
		if k := key(x); !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	bucketed := make([][3]any, len(rows))
	for i, r := range rows {
		bucketed[i] = [3]any{key(r[0].(string)), r[1], r[2]}
	}
	return out, bucketed
}
