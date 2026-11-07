package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"strings"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Chart PNGs for the bot report, in the look of the web charts: Manrope (the design system font), the
// categorical palette in fixed order, rounded data ends, recessive dashed grid. Drawn in logical pixels at 2x.
const (
	width  = 1200 // logical size; the PNG is scale times larger
	height = 675
	scale  = 2
	pad    = 40
)

var (
	//go:embed fonts/Manrope-Medium.ttf
	mediumTTF []byte
	//go:embed fonts/Manrope-Bold.ttf
	boldTTF []byte

	surface   = color.RGBA{0xfc, 0xfc, 0xfb, 0xff}
	inkStrong = color.RGBA{0x0b, 0x0b, 0x0b, 0xff}
	ink       = color.RGBA{0x52, 0x51, 0x4e, 0xff}
	gridInk   = color.RGBA{0xe4, 0xe3, 0xdf, 0xff}
	track     = color.RGBA{0xf0, 0xef, 0xec, 0xff}
	other     = color.RGBA{0xa1, 0xa1, 0xaa, 0xff}
	palette   = []color.RGBA{
		{0x2a, 0x78, 0xd6, 0xff}, {0xeb, 0x68, 0x34, 0xff}, {0x1b, 0xaf, 0x7a, 0xff}, {0xed, 0xa1, 0x00, 0xff},
		{0xe8, 0x7b, 0xa4, 0xff}, {0x00, 0x83, 0x00, 0xff}, {0x62, 0x50, 0xd6, 0xff}, {0xe3, 0x49, 0x48, 0xff},
	}
	ramp  = []color.RGBA{{0xe6, 0xf0, 0xfb, 0xff}, {0x2a, 0x78, 0xd6, 0xff}, {0x0d, 0x3d, 0x78, 0xff}} // sequential, one hue
	faces = map[[2]float64]font.Face{}
)

func face(size float64, bold bool) font.Face {
	key := [2]float64{size, 0}
	src := mediumTTF
	if bold {
		key[1], src = 1, boldTTF
	}
	if f, ok := faces[key]; ok {
		return f
	}
	tt, _ := opentype.Parse(src)
	f, _ := opentype.NewFace(tt, &opentype.FaceOptions{Size: size * scale, DPI: 72, Hinting: font.HintingNone})
	faces[key] = f
	return f
}

type canvas struct {
	img  *image.RGBA
	w, h float64 // logical size
}

func newCanvas(h float64) *canvas {
	c := &canvas{image.NewRGBA(image.Rect(0, 0, width*scale, int(h*scale))), width, h}
	for i := 0; i < len(c.img.Pix); i += 4 {
		c.img.Pix[i], c.img.Pix[i+1], c.img.Pix[i+2], c.img.Pix[i+3] = surface.R, surface.G, surface.B, 0xff
	}
	return c
}

func (c *canvas) png() []byte {
	var b bytes.Buffer
	_ = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&b, c.img)
	return b.Bytes()
}

// blend paints one device pixel with coverage a (0..1).
func (c *canvas) blend(x, y int, col color.RGBA, a float64) {
	b := c.img.Bounds()
	if x < 0 || y < 0 || x >= b.Dx() || y >= b.Dy() || a <= 0 {
		return
	}
	i := c.img.PixOffset(x, y)
	p := c.img.Pix[i : i+3]
	a = math.Min(a, 1)
	for k, v := range []uint8{col.R, col.G, col.B} {
		p[k] = uint8(float64(p[k])*(1-a) + float64(v)*a + 0.5)
	}
}

// fill paints polygons (logical coordinates, nonzero) with antialiasing; alpha may depend on the logical y.
func (c *canvas) fill(polys [][][2]float64, col color.RGBA, alpha func(y float64) float64) {
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range polys {
		for _, q := range p {
			minX, minY, maxX, maxY = math.Min(minX, q[0]), math.Min(minY, q[1]), math.Max(maxX, q[0]), math.Max(maxY, q[1])
		}
	}
	if math.IsInf(minX, 0) {
		return
	}
	x0, y0 := int(math.Floor(minX*scale))-1, int(math.Floor(minY*scale))-1
	w, h := int(math.Ceil(maxX*scale))+2-x0, int(math.Ceil(maxY*scale))+2-y0
	z := vector.NewRasterizer(w, h)
	pt := func(q [2]float64) (float32, float32) {
		return float32(q[0]*scale - float64(x0)), float32(q[1]*scale - float64(y0))
	}
	for _, p := range polys {
		if len(p) < 3 {
			continue
		}
		z.MoveTo(pt(p[0]))
		for _, q := range p[1:] {
			z.LineTo(pt(q))
		}
		z.ClosePath()
	}
	mask := image.NewAlpha(image.Rect(0, 0, w, h))
	z.Draw(mask, mask.Bounds(), image.Opaque, image.Point{})
	for i, m := range mask.Pix {
		if m > 0 {
			x, y := i%w+x0, i/w+y0
			c.blend(x, y, col, alpha(float64(y)/scale)*float64(m)/255)
		}
	}
}

func solid(a float64) func(float64) float64 { return func(float64) float64 { return a } }

// roundRect is a rectangle with radius r on the chosen corners (top-left, top-right, bottom-right, bottom-left).
func roundRect(x0, y0, x1, y1, r float64, corners [4]bool) [][2]float64 {
	r = math.Min(r, math.Min((x1-x0)/2, (y1-y0)/2))
	var p [][2]float64
	arc := func(cx, cy, from float64, on bool, x, y float64) {
		if !on || r <= 0 {
			p = append(p, [2]float64{x, y})
			return
		}
		for k := 0; k <= 6; k++ {
			a := from + float64(k)/6*math.Pi/2
			p = append(p, [2]float64{cx + r*math.Cos(a), cy + r*math.Sin(a)})
		}
	}
	arc(x0+r, y0+r, math.Pi, corners[0], x0, y0)
	arc(x1-r, y0+r, -math.Pi/2, corners[1], x1, y0)
	arc(x1-r, y1-r, 0, corners[2], x1, y1)
	arc(x0+r, y1-r, math.Pi/2, corners[3], x0, y1)
	return p
}

var allCorners = [4]bool{true, true, true, true}

func (c *canvas) rect(x0, y0, x1, y1, r float64, corners [4]bool, col color.RGBA) {
	if x1 <= x0 || y1 <= y0 {
		return
	}
	c.fill([][][2]float64{roundRect(x0, y0, x1, y1, r, corners)}, col, solid(1))
}

// dot is an antialiased disc (logical units).
func (c *canvas) dot(cx, cy, r float64, col color.RGBA, alpha float64) {
	cx, cy, r = cx*scale, cy*scale, r*scale
	for y := int(cy - r - 1); y <= int(cy+r+1); y++ {
		for x := int(cx - r - 1); x <= int(cx+r+1); x++ {
			d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy)
			c.blend(x, y, col, alpha*math.Max(0, math.Min(1, r-d+0.5)))
		}
	}
}

// line is a polyline of width w with round joins.
func (c *canvas) line(pts [][2]float64, w float64, col color.RGBA) {
	var quads [][][2]float64
	for i := 1; i < len(pts); i++ {
		a, b := pts[i-1], pts[i]
		dx, dy := b[0]-a[0], b[1]-a[1]
		l := math.Hypot(dx, dy)
		if l == 0 {
			continue
		}
		nx, ny := -dy/l*w/2, dx/l*w/2
		quads = append(quads, [][2]float64{{a[0] + nx, a[1] + ny}, {b[0] + nx, b[1] + ny}, {b[0] - nx, b[1] - ny}, {a[0] - nx, a[1] - ny}})
	}
	for _, p := range pts {
		var disc [][2]float64
		for k := range 12 {
			a := float64(k) / 12 * 2 * math.Pi
			disc = append(disc, [2]float64{p[0] + w/2*math.Cos(a), p[1] + w/2*math.Sin(a)})
		}
		quads = append(quads, disc)
	}
	c.fill(quads, col, solid(1))
}

// dashed is a horizontal dashed line (the grid).
func (c *canvas) dashed(x0, x1, y float64) {
	for x := x0; x < x1; x += 8 {
		c.rect(x, y-0.5, math.Min(x+4, x1), y+0.5, 0, [4]bool{}, gridInk)
	}
}

// clean drops runes the font has no glyph for (emoji, CJK), so labels do not show boxes.
func clean(s string) string {
	f := face(14, false)
	var b strings.Builder
	for _, r := range s {
		if _, ok := f.GlyphAdvance(r); ok || r == ' ' {
			b.WriteRune(r)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func textWidth(s string, size float64, bold bool) float64 {
	return float64(font.MeasureString(face(size, bold), s)) / 64 / scale
}

type textStyle struct {
	size  float64
	bold  bool
	col   color.RGBA
	align int     // -1 left, 0 center, 1 right
	maxW  float64 // cut with "…" (0: no limit)
}

var (
	axisText  = textStyle{size: 15, col: ink}
	valueText = textStyle{size: 15, bold: true, col: inkStrong}
)

// text draws s with its vertical middle at y (logical units).
func (c *canvas) text(x, y float64, s string, st textStyle) float64 {
	s = clean(s)
	for st.maxW > 0 && textWidth(s, st.size, st.bold) > st.maxW && len([]rune(s)) > 1 {
		r := []rune(strings.TrimSuffix(s, "…"))
		s = string(r[:len(r)-1]) + "…"
	}
	w := textWidth(s, st.size, st.bold)
	x -= w * float64(st.align+1) / 2
	f := face(st.size, st.bold)
	d := font.Drawer{Dst: c.img, Src: image.NewUniform(st.col), Face: f, Dot: fixed.P(int(x*scale), int((y+st.size*0.36)*scale))}
	d.DrawString(s)
	return w
}

// niceTicks are round axis values from 0 to at least max.
func niceTicks(max float64, n int) []float64 {
	if max <= 0 {
		max = 1
	}
	raw := max / float64(n)
	mag := math.Pow(10, math.Floor(math.Log10(raw)))
	step := mag
	for _, m := range []float64{1, 2, 5, 10} {
		if m*mag >= raw {
			step = m * mag
			break
		}
	}
	var ticks []float64
	for v := 0.0; v < max+step*0.999; v += step {
		ticks = append(ticks, v)
	}
	return ticks
}

func number(v float64) string {
	switch {
	case v >= 1e6:
		return fmt.Sprintf("%.1fM", v/1e6)
	case v >= 1e4:
		return fmt.Sprintf("%.0fk", v/1e3)
	case v >= 1e3:
		return fmt.Sprintf("%.1fk", v/1e3)
	case v == math.Trunc(v):
		return fmt.Sprintf("%.0f", v)
	case v >= 0.1:
		return fmt.Sprintf("%.2f", v)
	default:
		return fmt.Sprintf("%.2g", v)
	}
}

func money(v float64) string {
	if v >= 1 || v == 0 {
		return fmt.Sprintf("$%.2f", v)
	}
	return fmt.Sprintf("$%.2g", v)
}

type series struct {
	name   string
	values []float64
	color  color.RGBA
}

// legend draws the series names in one row; returns the top of the plot.
func (c *canvas) legend(ss []series) float64 {
	if len(ss) < 2 {
		return pad
	}
	x := float64(pad)
	for _, s := range ss {
		c.rect(x, pad-6, x+12, pad+6, 3, allCorners, s.color)
		x += 20 + c.text(x+20, pad, s.name, textStyle{size: 15, col: inkStrong, align: -1, maxW: 180}) + 24
	}
	return pad + 36
}

// plot is the area of an axis chart with its value axis on the left.
type plot struct{ x0, y0, x1, y1, max float64 }

func (p plot) y(v float64) float64 { return p.y1 - v/p.max*(p.y1-p.y0) }

func (c *canvas) valueAxis(top, max float64, format func(float64) string) plot {
	ticks := niceTicks(max, 4)
	labelW := 0.0
	for _, t := range ticks {
		labelW = math.Max(labelW, textWidth(format(t), axisText.size, false))
	}
	p := plot{pad + labelW + 14, top, c.w - pad, c.h - pad - 28, ticks[len(ticks)-1]}
	for _, t := range ticks {
		y := p.y(t)
		if t == 0 {
			c.rect(p.x0, y-0.5, p.x1, y+0.5, 0, [4]bool{}, gridInk)
		} else {
			c.dashed(p.x0, p.x1, y)
		}
		c.text(p.x0-14, y, format(t), textStyle{size: axisText.size, col: ink, align: 1})
	}
	return p
}

// categoryLabels draws up to ~8 evenly spaced labels under the x axis.
func (c *canvas) categoryLabels(p plot, xs []string) {
	step := max(1, (len(xs)+7)/8)
	bw := (p.x1 - p.x0) / float64(len(xs))
	for i := 0; i < len(xs); i += step {
		c.text(p.x0+bw*(float64(i)+0.5), p.y1+22, shortDate(xs[i]), textStyle{size: axisText.size, col: ink, maxW: bw * float64(step)})
	}
}

// stackedBars: one bar per x with stacked segments, a 2 px gap between them and a rounded top.
func stackedBars(xs []string, ss []series, format func(float64) string) []byte {
	c := newCanvas(height)
	top := c.legend(ss)
	totals := make([]float64, len(xs))
	maxV := 0.0
	for i := range xs {
		for _, s := range ss {
			totals[i] += s.values[i]
		}
		maxV = math.Max(maxV, totals[i])
	}
	labels := len(xs) <= 16 && format(0.5) != "50%" // shares always sum to 100%: no totals
	if labels {
		top += 20 // room for the value labels
	}
	p := c.valueAxis(top, maxV, format)
	slot := (p.x1 - p.x0) / float64(len(xs))
	bw := math.Min(slot*0.72, 56)
	for i := range xs {
		x := p.x0 + slot*float64(i) + (slot-bw)/2
		base := 0.0
		last := -1
		for k, s := range ss {
			if s.values[i] > 0 {
				last = k
			}
		}
		for k, s := range ss {
			v := s.values[i]
			if v <= 0 {
				continue
			}
			y0, y1 := p.y(base+v), p.y(base)
			if base > 0 {
				y1 -= 2 // surface gap between segments
			}
			c.rect(x, y0, x+bw, y1, 4, [4]bool{k == last, k == last, false, false}, s.color)
			base += v
		}
		if labels && totals[i] > 0 {
			c.text(x+bw/2, p.y(totals[i])-14, format(totals[i]), valueText)
		}
	}
	c.categoryLabels(p, xs)
	return c.png()
}

// lineChart: lines over shared x values; a single line gets a fading area and its last value.
func lineChart(xs []string, ss []series, format func(float64) string) []byte {
	c := newCanvas(height)
	top := c.legend(ss)
	maxV := 0.0
	for _, s := range ss {
		for _, v := range s.values {
			maxV = math.Max(maxV, v)
		}
	}
	p := c.valueAxis(top+12, maxV, format)
	slot := (p.x1 - p.x0) / float64(max(1, len(xs)))
	for _, s := range ss {
		pts := make([][2]float64, len(s.values))
		for i, v := range s.values {
			pts[i] = [2]float64{p.x0 + slot*(float64(i)+0.5), p.y(v)}
		}
		if len(ss) == 1 && len(pts) > 1 {
			area := append(append([][2]float64{{pts[0][0], p.y1}}, pts...), [2]float64{pts[len(pts)-1][0], p.y1})
			c.fill([][][2]float64{area}, s.color, func(y float64) float64 { return 0.22 * (p.y1 - y) / (p.y1 - p.y0) })
		}
		c.line(pts, 2.5, s.color)
		if len(pts) <= 24 {
			for _, q := range pts {
				c.dot(q[0], q[1], 4.5, surface, 1)
				c.dot(q[0], q[1], 3, s.color, 1)
			}
		}
		if len(ss) == 1 && len(pts) > 0 {
			last := pts[len(pts)-1]
			c.text(last[0], last[1]-18, format(s.values[len(s.values)-1]), textStyle{size: 15, bold: true, col: inkStrong, align: 1})
		}
	}
	c.categoryLabels(p, xs)
	return c.png()
}

type kv struct {
	name  string
	value float64
}

// hbars: horizontal pill bars on a light track, largest on top; the height follows the number of rows.
func hbars(items []kv, format func(float64) string) []byte {
	items = items[:min(len(items), 20)]
	const row = 40.0
	c := newCanvas(math.Max(240, 2*pad+row*float64(len(items))))
	maxV, labelW := 0.0, 0.0
	for _, it := range items {
		maxV = math.Max(maxV, it.value)
		labelW = math.Max(labelW, math.Min(280, textWidth(clean(it.name), 16, false)))
	}
	x0, x1 := pad+labelW+16, c.w-pad-90
	top := (c.h - row*float64(len(items))) / 2
	for i, it := range items {
		y := top + row*(float64(i)+0.5)
		w := 0.0
		if maxV > 0 {
			w = math.Max(it.value/maxV*(x1-x0), 6)
		}
		c.rect(x0, y-10, x1, y+10, 10, allCorners, track)
		c.rect(x0, y-10, x0+w, y+10, 10, allCorners, palette[0])
		c.text(x0-16, y, it.name, textStyle{size: 16, col: inkStrong, align: 1, maxW: 280})
		c.text(x1+14, y, format(it.value), textStyle{size: 16, bold: true, col: inkStrong, align: -1})
	}
	return c.png()
}

func lerp(a, b color.RGBA, t float64) color.RGBA {
	f := func(x, y uint8) uint8 { return uint8(float64(x) + (float64(y)-float64(x))*t) }
	return color.RGBA{f(a.R, b.R), f(a.G, b.G), f(a.B, b.B), 0xff}
}

// sequential maps 0..1 to the one-hue ramp.
func sequential(t float64) color.RGBA {
	t = math.Max(0, math.Min(1, t))
	if t < 0.5 {
		return lerp(ramp[0], ramp[1], t*2)
	}
	return lerp(ramp[1], ramp[2], (t-0.5)*2)
}

// heatmapChart: rounded cells[y][x] with row and column labels and a small less → more key.
func heatmapChart(xs, ys []string, cells [][]float64) []byte {
	labelW := 0.0
	for _, y := range ys {
		labelW = math.Max(labelW, math.Min(200, textWidth(clean(y), 15, false)))
	}
	cw := math.Min(48, (width-2*pad-labelW-14)/float64(len(xs)))
	ch := math.Min(48, cw*1.6)
	c := newCanvas(2*pad + ch*float64(len(ys)) + 70)
	x0 := (c.w - (labelW + 14 + cw*float64(len(xs)))) / 2
	x0 += labelW + 14
	y0 := float64(pad)
	maxV := 0.0
	for _, r := range cells {
		for _, v := range r {
			maxV = math.Max(maxV, v)
		}
	}
	for j, r := range cells {
		for i, v := range r {
			col := track
			if v > 0 {
				col = sequential(0.1 + 0.9*v/math.Max(maxV, 1))
			}
			c.rect(x0+cw*float64(i)+1.5, y0+ch*float64(j)+1.5, x0+cw*float64(i+1)-1.5, y0+ch*float64(j+1)-1.5, 4, allCorners, col)
		}
		c.text(x0-14, y0+ch*(float64(j)+0.5), ys[j], textStyle{size: 15, col: ink, align: 1, maxW: 200})
	}
	step := max(1, int(math.Ceil(44/cw)))
	yl := y0 + ch*float64(len(ys)) + 22
	for i := 0; i < len(xs); i += step {
		c.text(x0+cw*(float64(i)+0.5), yl, xs[i], textStyle{size: 14, col: ink, maxW: cw * float64(step)})
	}
	kx := x0 + cw*float64(len(xs)) - 5*18
	for k := range 5 {
		c.rect(kx+float64(k)*18, yl+22, kx+float64(k)*18+14, yl+36, 3, allCorners, sequential(0.1+0.9*float64(k)/4))
	}
	c.text(kx-10, yl+29, tr("less"), textStyle{size: 13, col: ink, align: 1})
	c.text(kx+5*18+4, yl+29, tr("more"), textStyle{size: 13, col: ink, align: -1})
	return c.png()
}

type label struct {
	x, y float64
	text string
}

// scatterChart: points fitted to the canvas, each with a thin surface ring; group -1 is gray and drawn first.
// Labels are white pills; one that would overlap a placed one is skipped.
func scatterChart(xy [][2]float64, group []int, labels []label, _ bool) []byte {
	c := newCanvas(height)
	if len(xy) == 0 {
		return c.png()
	}
	minX, maxX, minY, maxY := xy[0][0], xy[0][0], xy[0][1], xy[0][1]
	for _, p := range xy {
		minX, maxX, minY, maxY = math.Min(minX, p[0]), math.Max(maxX, p[0]), math.Min(minY, p[1]), math.Max(maxY, p[1])
	}
	s := math.Min((c.w-2*pad)/math.Max(maxX-minX, 1e-9), (c.h-2*pad)/math.Max(maxY-minY, 1e-9))
	ox, oy := (c.w-(maxX-minX)*s)/2, (c.h-(maxY-minY)*s)/2
	at := func(x, y float64) (float64, float64) { return ox + (x-minX)*s, c.h - (oy + (y-minY)*s) }
	r := math.Max(1.6, math.Min(4.5, 420/math.Sqrt(float64(len(xy)))))
	for pass := range 2 {
		for i, p := range xy {
			g := -1
			if group != nil {
				g = group[i]
			}
			if (g < 0) != (pass == 0) {
				continue
			}
			col, a := other, 0.4
			if g >= 0 {
				col, a = palette[g%len(palette)], 0.85
			}
			x, y := at(p[0], p[1])
			if r >= 3 {
				c.dot(x, y, r+1, surface, 0.9)
			}
			c.dot(x, y, r, col, a)
		}
	}
	var placed []image.Rectangle
	for _, l := range labels {
		x, y := at(l.x, l.y)
		st := textStyle{size: 15, bold: true, col: inkStrong, maxW: 260}
		w := math.Min(textWidth(clean(l.text), st.size, true), 260)
		box := image.Rect(int(x-w/2-10), int(y-14), int(x+w/2+10), int(y+14))
		overlap := false
		for _, b := range placed {
			if b.Inset(-4).Overlaps(box) {
				overlap = true
				break
			}
		}
		if overlap {
			continue
		}
		placed = append(placed, box)
		bx := [4]float64{float64(box.Min.X), float64(box.Min.Y), float64(box.Max.X), float64(box.Max.Y)}
		c.rect(bx[0]-1, bx[1]-1, bx[2]+1, bx[3]+1, 15, allCorners, gridInk)
		c.rect(bx[0], bx[1], bx[2], bx[3], 14, allCorners, color.RGBA{0xff, 0xff, 0xff, 0xff})
		c.text(x, y, l.text, st)
	}
	return c.png()
}

// bubbleChart: the tag map, a bubble per tag sized by its count with the tag in the middle; the largest
// tags are drawn first, so their labels win over overlapping smaller ones.
func bubbleChart(tags []tagPoint) []byte {
	c := newCanvas(height)
	if len(tags) == 0 {
		return c.png()
	}
	minX, maxX, minY, maxY := tags[0].X, tags[0].X, tags[0].Y, tags[0].Y
	maxN := 1
	for _, t := range tags {
		minX, maxX, minY, maxY = math.Min(minX, t.X), math.Max(maxX, t.X), math.Min(minY, t.Y), math.Max(maxY, t.Y)
		maxN = max(maxN, t.N)
	}
	m := pad + 40.0
	s := math.Min((c.w-2*m)/math.Max(maxX-minX, 1e-9), (c.h-2*m)/math.Max(maxY-minY, 1e-9))
	ox, oy := (c.w-(maxX-minX)*s)/2, (c.h-(maxY-minY)*s)/2
	radius := func(n int) float64 { return 8 + 36*math.Sqrt(float64(n)/float64(maxN)) }
	for _, t := range tags {
		x, y := ox+(t.X-minX)*s, c.h-(oy+(t.Y-minY)*s)
		c.dot(x, y, radius(t.N), palette[0], 0.14)
	}
	var placed []image.Rectangle
	for _, t := range tags { // tagMap returns them by count, largest first
		x, y := ox+(t.X-minX)*s, c.h-(oy+(t.Y-minY)*s)
		size := 13 + 5*math.Sqrt(float64(t.N)/float64(maxN))
		w := math.Min(textWidth(clean(t.Tag), size, true), 200)
		box := image.Rect(int(x-w/2-3), int(y-size*0.7), int(x+w/2+3), int(y+size*0.7))
		overlap := false
		for _, b := range placed {
			if b.Overlaps(box) {
				overlap = true
				break
			}
		}
		if overlap {
			continue
		}
		placed = append(placed, box)
		c.text(x, y, t.Tag, textStyle{size: size, bold: true, col: inkStrong, maxW: 200})
	}
	return c.png()
}
