package main

import (
	"math"
	"math/rand/v2"
	"sort"
)

type edge struct {
	a, b int
	w    float64
}

// fuzzyGraph is the UMAP neighbor graph: per-point smooth kNN weights, symmetrized as a fuzzy union.
func fuzzyGraph(idx [][]int, sim [][]float32) []edge {
	directed := map[[2]int]float64{}
	for i, ids := range idx {
		if len(ids) == 0 {
			continue
		}
		dist := make([]float64, len(ids))
		for j, s := range sim[i] {
			dist[j] = math.Max(0, 1-float64(s))
		}
		rho := dist[0]
		target := math.Log2(float64(len(ids)))
		lo, hi, sigma := 0.0, math.Inf(1), 1.0
		for range 64 {
			sum := 0.0
			for _, d := range dist {
				sum += math.Exp(-math.Max(0, d-rho) / sigma)
			}
			if math.Abs(sum-target) < 1e-5 {
				break
			}
			if sum > target {
				hi = sigma
				sigma = (lo + hi) / 2
			} else {
				lo = sigma
				if math.IsInf(hi, 1) {
					sigma *= 2
				} else {
					sigma = (lo + hi) / 2
				}
			}
		}
		for j, d := range dist {
			directed[[2]int{i, ids[j]}] = math.Exp(-math.Max(0, d-rho) / math.Max(sigma, 1e-3*meanOf(dist)+1e-12))
		}
	}
	var edges []edge
	for k, w := range directed {
		back, ok := directed[[2]int{k[1], k[0]}]
		if ok && k[0] > k[1] {
			continue // the pair is added once, from its smaller index
		}
		edges = append(edges, edge{k[0], k[1], w + back - w*back})
	}
	sort.Slice(edges, func(i, j int) bool {
		return edges[i].a < edges[j].a || (edges[i].a == edges[j].a && edges[i].b < edges[j].b)
	})
	return edges
}

func meanOf(v []float64) float64 {
	s := 0.0
	for _, x := range v {
		s += x
	}
	return s / float64(len(v))
}

// layout places the graph in len(init[0]) dimensions (2 for the maps, 3 for the web 3D view): UMAP's SGD
// with negative sampling (min_dist 0.1, spread 1), from the PCA init. Edges of an epoch run on all CPUs
// without locks (Hogwild, as umap-learn with parallel=True): a rare lost update only adds noise to one step.
func layout(edges []edge, init [][]float64) [][]float64 {
	const a, b, negRate = 1.577, 0.895, 5
	n := len(init)
	if n == 0 {
		return init
	}
	dim := len(init[0])
	scale := 0.0
	for _, p := range init {
		for _, v := range p {
			scale = math.Max(scale, math.Abs(v))
		}
	}
	rng := rand.New(rand.NewPCG(3, 4))
	y := make([][]float64, n)
	for i, p := range init {
		y[i] = make([]float64, dim)
		for d, v := range p {
			y[i][d] = 10*v/math.Max(scale, 1e-9) + rng.NormFloat64()*1e-4
		}
	}
	epochs := 500
	if n > 10000 {
		epochs = 200
	}
	maxW := 0.0
	for _, e := range edges {
		maxW = math.Max(maxW, e.w)
	}
	var live []edge
	for _, e := range edges {
		if e.w >= maxW/float64(epochs) {
			live = append(live, e)
		}
	}
	every, next, everyNeg, nextNeg := make([]float64, len(live)), make([]float64, len(live)), make([]float64, len(live)), make([]float64, len(live))
	for i, e := range live {
		every[i] = maxW / e.w
		next[i] = every[i]
		everyNeg[i] = every[i] / negRate
		nextNeg[i] = everyNeg[i]
	}
	clip := func(v float64) float64 { return math.Max(-4, math.Min(4, v)) }
	dist2 := func(p, q []float64) float64 {
		s := 0.0
		for d := range p {
			s += (p[d] - q[d]) * (p[d] - q[d])
		}
		return s
	}
	for epoch := range epochs {
		alpha := 1 - float64(epoch)/float64(epochs)
		parallel(len(live), func(lo, hi int) {
			rng := rand.New(rand.NewPCG(uint64(epoch), uint64(lo)))
			for k := lo; k < hi; k++ {
				e := live[k]
				if next[k] > float64(epoch) {
					continue
				}
				yi, yj := y[e.a], y[e.b]
				if d2 := dist2(yi, yj); d2 > 0 {
					g := -2 * a * b * math.Pow(d2, b-1) / (a*math.Pow(d2, b) + 1)
					for d := range yi {
						step := clip(g*(yi[d]-yj[d])) * alpha
						yi[d] += step
						yj[d] -= step
					}
				}
				next[k] += every[k]
				negs := int((float64(epoch) - nextNeg[k]) / everyNeg[k])
				for range negs {
					o := rng.IntN(n)
					if o == e.a {
						continue
					}
					yo := y[o]
					d2 := dist2(yi, yo)
					for d := range yi {
						step := 4.0
						if d2 > 0 {
							step = clip(2 * b / ((0.001 + d2) * (a*math.Pow(d2, b) + 1)) * (yi[d] - yo[d]))
						}
						yi[d] += step * alpha
					}
				}
				nextNeg[k] += float64(negs) * everyNeg[k]
			}
		})
	}
	return y
}

// louvain finds communities of a weighted graph (modularity, resolution 1); returns a label per node.
func louvain(n int, edges []edge) []int {
	label := make([]int, n)
	for i := range label {
		label[i] = i
	}
	nodes, es := n, edges
	for {
		comm, moved := localMoves(nodes, es)
		if !moved {
			break
		}
		// Renumber and aggregate: communities become the nodes of the next level.
		ids := map[int]int{}
		for i, c := range comm {
			if _, ok := ids[c]; !ok {
				ids[c] = len(ids)
			}
			comm[i] = ids[c]
		}
		for i := range label {
			label[i] = comm[label[i]]
		}
		agg := map[[2]int]float64{}
		for _, e := range es {
			a, b := comm[e.a], comm[e.b]
			if a > b {
				a, b = b, a
			}
			agg[[2]int{a, b}] += e.w
		}
		es = es[:0:0]
		for k, w := range agg {
			es = append(es, edge{k[0], k[1], w})
		}
		sort.Slice(es, func(i, j int) bool { return es[i].a < es[j].a || (es[i].a == es[j].a && es[i].b < es[j].b) })
		nodes = len(ids)
	}
	return label
}

// localMoves is one Louvain level: moves nodes to the neighbor community with the best modularity gain.
func localMoves(n int, edges []edge) ([]int, bool) {
	type link struct {
		to int
		w  float64
	}
	adj := make([][]link, n)
	k := make([]float64, n) // weighted degree; a self loop counts twice
	m2 := 0.0
	for _, e := range edges {
		adj[e.a] = append(adj[e.a], link{e.b, e.w})
		if e.a != e.b {
			adj[e.b] = append(adj[e.b], link{e.a, e.w})
		}
		k[e.a] += e.w
		k[e.b] += e.w
		m2 += 2 * e.w
	}
	comm := make([]int, n)
	tot := make([]float64, n)
	for i := range comm {
		comm[i], tot[i] = i, k[i]
	}
	if m2 == 0 {
		return comm, false
	}
	moved := false
	for pass := 0; pass < 20; pass++ {
		changed := false
		for i := range n {
			links := map[int]float64{}
			for _, l := range adj[i] {
				if l.to != i {
					links[comm[l.to]] += l.w
				}
			}
			old := comm[i]
			tot[old] -= k[i]
			best, gain := old, links[old]-tot[old]*k[i]/m2
			for c, w := range links {
				if g := w - tot[c]*k[i]/m2; g > gain+1e-12 {
					best, gain = c, g
				}
			}
			comm[i] = best
			tot[best] += k[i]
			if best != old {
				changed, moved = true, true
			}
		}
		if !changed {
			break
		}
	}
	return comm, moved
}
