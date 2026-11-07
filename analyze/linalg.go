package main

import (
	"math"
	"math/rand/v2"
	"runtime"
	"sort"
	"sync"
)

// mat is a dense row-major n×d matrix.
type mat struct {
	n, d int
	v    []float32
}

func newMat(n, d int) mat { return mat{n, d, make([]float32, n*d)} }

func (m mat) row(i int) []float32 { return m.v[i*m.d : (i+1)*m.d] }

func dot(a, b []float32) float64 {
	var s float32
	for i := range a {
		s += a[i] * b[i]
	}
	return float64(s)
}

// normalize scales every row to unit length (cosine similarity = dot product).
func normalize(m mat) mat {
	for i := range m.n {
		r := m.row(i)
		if l := math.Sqrt(dot(r, r)); l > 0 {
			for j := range r {
				r[j] /= float32(l)
			}
		}
	}
	return m
}

// parallel runs f over [0, n) split into one range per CPU.
func parallel(n int, f func(lo, hi int)) {
	w := runtime.GOMAXPROCS(0)
	step := (n + w - 1) / w
	var wg sync.WaitGroup
	for lo := 0; lo < n; lo += step {
		wg.Add(1)
		go func(lo, hi int) {
			defer wg.Done()
			f(lo, hi)
		}(lo, min(lo+step, n))
	}
	wg.Wait()
}

// mul is a (n×d) · b (d×k).
func mul(a mat, b [][]float64) mat {
	k := len(b[0])
	out := newMat(a.n, k)
	parallel(a.n, func(lo, hi int) {
		for i := lo; i < hi; i++ {
			r, o := a.row(i), out.row(i)
			for j, x := range r {
				if x == 0 {
					continue
				}
				bj := b[j]
				for c := range k {
					o[c] += x * float32(bj[c])
				}
			}
		}
	})
	return out
}

// mulT is aᵀ (d×n) · q (n×k), as d×k.
func mulT(a, q mat) [][]float64 {
	var mu sync.Mutex
	out := zeros(a.d, q.d)
	parallel(a.n, func(lo, hi int) {
		local := zeros(a.d, q.d)
		for i := lo; i < hi; i++ {
			r, qr := a.row(i), q.row(i)
			for j, x := range r {
				for c, y := range qr {
					local[j][c] += float64(x * y)
				}
			}
		}
		mu.Lock()
		for j := range local {
			for c := range local[j] {
				out[j][c] += local[j][c]
			}
		}
		mu.Unlock()
	})
	return out
}

func zeros(n, k int) [][]float64 {
	m := make([][]float64, n)
	for i := range m {
		m[i] = make([]float64, k)
	}
	return m
}

// orth makes the columns of m orthonormal (modified Gram-Schmidt, twice for stability).
func orth(m mat) mat {
	col := func(c int, f func(i int, x *float32)) {
		for i := range m.n {
			f(i, &m.v[i*m.d+c])
		}
	}
	for range 2 {
		for c := range m.d {
			for p := range c {
				var s float64
				col(c, func(i int, x *float32) { s += float64(*x * m.v[i*m.d+p]) })
				col(c, func(i int, x *float32) { *x -= float32(s) * m.v[i*m.d+p] })
			}
			var l float64
			col(c, func(_ int, x *float32) { l += float64(*x * *x) })
			l = math.Sqrt(l)
			col(c, func(_ int, x *float32) {
				if l > 1e-12 {
					*x /= float32(l)
				} else {
					*x = 0
				}
			})
		}
	}
	return m
}

func toCols(m [][]float64) mat {
	out := newMat(len(m), len(m[0]))
	for i, r := range m {
		for j, x := range r {
			out.v[i*out.d+j] = float32(x)
		}
	}
	return out
}

// jacobi returns eigenvalues (descending) and eigenvectors (columns) of a small symmetric matrix.
func jacobi(a [][]float64) ([]float64, [][]float64) {
	n := len(a)
	v := zeros(n, n)
	for i := range n {
		v[i][i] = 1
	}
	for range 100 {
		off := 0.0
		for p := range n {
			for q := p + 1; q < n; q++ {
				off += a[p][q] * a[p][q]
			}
		}
		if off < 1e-20 {
			break
		}
		for p := range n {
			for q := p + 1; q < n; q++ {
				if math.Abs(a[p][q]) < 1e-30 {
					continue
				}
				theta := (a[q][q] - a[p][p]) / (2 * a[p][q])
				t := math.Copysign(1, theta) / (math.Abs(theta) + math.Sqrt(theta*theta+1))
				c := 1 / math.Sqrt(t*t+1)
				s := t * c
				for k := range n {
					akp, akq := a[k][p], a[k][q]
					a[k][p], a[k][q] = c*akp-s*akq, s*akp+c*akq
				}
				for k := range n {
					apk, aqk := a[p][k], a[q][k]
					a[p][k], a[q][k] = c*apk-s*aqk, s*apk+c*aqk
				}
				for k := range n {
					vkp, vkq := v[k][p], v[k][q]
					v[k][p], v[k][q] = c*vkp-s*vkq, s*vkp+c*vkq
				}
			}
		}
	}
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(i, j int) bool { return a[order[i]][order[i]] > a[order[j]][order[j]] })
	vals, vecs := make([]float64, n), zeros(n, n)
	for c, o := range order {
		vals[c] = a[o][o]
		for r := range n {
			vecs[r][c] = v[r][o]
		}
	}
	return vals, vecs
}

// pcaModel projects rows to the top principal components.
type pcaModel struct {
	mean  []float32
	basis [][]float64 // d×k
	ratio []float64   // explained variance ratio per component
}

func (p pcaModel) transform(x mat) mat {
	c := newMat(x.n, x.d)
	for i := range x.n {
		for j, v := range x.row(i) {
			c.v[i*c.d+j] = v - p.mean[j]
		}
	}
	return mul(c, p.basis)
}

// pca fits k components with a randomized SVD (range finder + 2 power iterations) of the centered data.
func pca(x mat, k int) pcaModel {
	k = min(k, x.n-1, x.d)
	l := min(k+10, x.n, x.d)
	mean := make([]float32, x.d)
	for i := range x.n {
		for j, v := range x.row(i) {
			mean[j] += v / float32(x.n)
		}
	}
	a := newMat(x.n, x.d)
	var total float64
	for i := range x.n {
		for j, v := range x.row(i) {
			c := v - mean[j]
			a.v[i*a.d+j] = c
			total += float64(c * c)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	omega := zeros(x.d, l)
	for j := range omega {
		for c := range omega[j] {
			omega[j][c] = rng.NormFloat64()
		}
	}
	q := orth(mul(a, omega))
	for range 2 {
		q = orth(mul(a, orthRows(mulT(a, q))))
	}
	b := mulT(a, q) // d×l = (qᵀ a)ᵀ
	gram := zeros(l, l)
	for _, r := range b {
		for i := range l {
			for j := range l {
				gram[i][j] += r[i] * r[j]
			}
		}
	}
	vals, vecs := jacobi(gram)
	basis := zeros(x.d, k)
	ratio := make([]float64, k)
	for c := range k {
		s := math.Sqrt(math.Max(vals[c], 1e-30))
		if total > 0 {
			ratio[c] = vals[c] / total
		}
		for j := range x.d {
			var v float64
			for i := range l {
				v += b[j][i] * vecs[i][c]
			}
			basis[j][c] = v / s
		}
	}
	return pcaModel{mean, basis, ratio}
}

// orthRows orthonormalizes the columns of a d×l matrix given as rows.
func orthRows(m [][]float64) [][]float64 {
	o := orth(toCols(m))
	out := zeros(o.n, o.d)
	for i := range o.n {
		for j, v := range o.row(i) {
			out[i][j] = float64(v)
		}
	}
	return out
}

// knn finds the k most similar rows (cosine, rows normalized) of every row, most similar first, without itself.
func knn(x mat, k int) ([][]int, [][]float32) {
	k = min(k, x.n-1)
	idx, sim := make([][]int, x.n), make([][]float32, x.n)
	parallel(x.n, func(lo, hi int) {
		for i := lo; i < hi; i++ {
			ri := x.row(i)
			ids, ss := make([]int, 0, k+1), make([]float32, 0, k+1)
			for j := range x.n {
				if j == i {
					continue
				}
				s := float32(dot(ri, x.row(j)))
				if len(ss) == k && s <= ss[k-1] {
					continue
				}
				p := sort.Search(len(ss), func(p int) bool { return ss[p] < s })
				ss = append(ss, 0)
				ids = append(ids, 0)
				copy(ss[p+1:], ss[p:])
				copy(ids[p+1:], ids[p:])
				ss[p], ids[p] = s, j
				if len(ss) > k {
					ss, ids = ss[:k], ids[:k]
				}
			}
			idx[i], sim[i] = ids, ss
		}
	})
	return idx, sim
}
