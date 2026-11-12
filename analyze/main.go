// Embedding analysis job (src/analysis.ts): reads one user's memes and vectors from API_URL with the
// per-analysis TOKEN, builds 2D maps, clusters and similarity stats, uploads one result JSON.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// exitRestart tells the Worker (src/job.ts) to start the job again: SIGTERM comes from a platform rollout.
const exitRestart = 75

var apiURL, token = os.Getenv("API_URL"), os.Getenv("TOKEN")

func main() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM)
	go func() {
		<-stop
		log.Print("SIGTERM, exit for restart")
		os.Exit(exitRestart)
	}()
	if err := run(); err != nil {
		log.Print(err)
		_ = call("POST", "/fail", map[string]string{"error": err.Error()}, nil)
		os.Exit(1)
	}
}

// run: MODE=render only redraws the charts of the stored result (the Worker added LLM cluster names);
// otherwise it is the full analysis with a fresh snapshot of the SQL stats.
func run() error {
	p := &progress{}
	if os.Getenv("MODE") == "pair" {
		return runPair(p)
	}
	var r *result
	stage := "write"
	if os.Getenv("MODE") == "render" {
		stage = "render" // the Worker keeps the finished result if a redraw fails
		r = &result{}
		if err := call("GET", "/result", nil, r); err != nil {
			return err
		}
	} else {
		memes, vectors, err := fetch(p, math.MaxInt)
		if err != nil {
			return err
		}
		r = analyze(memes, vectors, fetchMoods(), p)
		if err := call("GET", "/analytics", nil, &r.Analytics); err != nil {
			return err
		}
	}
	var a analytics
	if err := json.Unmarshal(r.Analytics, &a); err != nil {
		log.Print("analytics: ", err)
	}
	r.Images = upload(p, stage, charts(&a, r))
	return finish(r)
}

// upload puts the chart PNGs; returns the names of the uploaded ones.
func upload(p *progress, stage string, images map[string][]byte) []string {
	p.report(stage, 0, len(images)+1)
	names := []string{}
	for name, png := range images {
		if err := put("/image/"+name, png); err != nil {
			log.Print("image ", name, ": ", err)
			continue
		}
		names = append(names, name)
		p.report(stage, len(names), len(images)+1)
	}
	return names
}

// finish stores the result JSON and marks the analysis done.
func finish(r any) error {
	if err := call("PUT", "/result", r, nil); err != nil {
		return err
	}
	return call("POST", "/done", map[string]string{}, nil)
}

type meme struct {
	ID, Kind, Lang string
	Created        int64
	Tags           []string
	Owner          int // pair analysis: 0 = pair.a, 1 = pair.b
}

// fetch reads the ready memes (at most limit per owner) and their image (":i") and text (":t") vectors,
// 10 memes per request.
func fetch(p *progress, limit int) ([]meme, map[string][]float32, error) {
	var memes []meme
	for after := any(0); after != nil; {
		var page struct {
			Rows [][]any `json:"rows"`
			Next any     `json:"next"`
		}
		if err := call("GET", fmt.Sprintf("/memes?after=%v", after), nil, &page); err != nil {
			return nil, nil, err
		}
		for _, r := range page.Rows {
			m := meme{ID: str(r[0]), Kind: str(r[1]), Lang: str(r[3])}
			if f, ok := r[2].(float64); ok {
				m.Created = int64(f)
			}
			for _, t := range strings.Split(str(r[4]), "\n") {
				if t != "" {
					m.Tags = append(m.Tags, t)
				}
			}
			if len(r) > 5 {
				if f, ok := r[5].(float64); ok {
					m.Owner = int(f)
				}
			}
			memes = append(memes, m)
		}
		after = page.Next
	}
	memes = sample(memes, limit)

	vectors := map[string][]float32{}
	var mu sync.Mutex
	var firstErr error
	done := 0
	jobs := make(chan []meme)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for chunk := range jobs {
				ids := make([]string, len(chunk))
				for i, m := range chunk {
					ids[i] = m.ID
				}
				var got []struct {
					ID     string    `json:"id"`
					Values []float32 `json:"values"`
				}
				err := call("GET", "/vectors?ids="+strings.Join(ids, ","), nil, &got)
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				for _, v := range got {
					vectors[v.ID] = v.Values
				}
				done += len(chunk)
				p.report("vectors", done, len(memes))
				mu.Unlock()
			}
		}()
	}
	p.report("vectors", 0, len(memes))
	for i := 0; i < len(memes) && firstErr == nil; i += 10 {
		jobs <- memes[i:min(i+10, len(memes))]
	}
	close(jobs)
	wg.Wait()
	return memes, vectors, firstErr
}

// sample keeps at most n memes per owner, in order: the ones with the lowest id hash, so a restart keeps the same.
func sample(memes []meme, n int) []meme {
	hash := func(id string) uint32 {
		h := fnv.New32a()
		h.Write([]byte(id))
		return h.Sum32()
	}
	byHash := append([]meme(nil), memes...)
	sort.SliceStable(byHash, func(a, b int) bool { return hash(byHash[a].ID) < hash(byHash[b].ID) })
	keep, per := map[string]bool{}, map[int]int{}
	for _, m := range byHash {
		if per[m.Owner] < n {
			per[m.Owner]++
			keep[m.ID] = true
		}
	}
	out := memes[:0:0]
	for _, m := range memes {
		if keep[m.ID] {
			out = append(out, m)
		}
	}
	return out
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// progress sends at most one report every 2 s, plus the start and the end of each stage.
type progress struct {
	stage string
	sent  time.Time
}

func (p *progress) report(stage string, done, total int) {
	if apiURL == "" || (stage == p.stage && done != total && time.Since(p.sent) < 2*time.Second) {
		return
	}
	p.stage, p.sent = stage, time.Now()
	if err := call("POST", "/progress", map[string]any{"stage": stage, "done": done, "total": total}, nil); err != nil {
		log.Print("progress: ", err)
	}
}

// put uploads raw bytes (a chart PNG) to the Worker.
func put(path string, data []byte) error { return call("PUT", path, rawBody(data), nil) }

// rawBody is sent as is, not as JSON.
type rawBody []byte

// call sends JSON to the Worker and decodes the answer into out; retries network errors, 429 and 5xx.
func call(method, path string, payload, out any) error {
	var body []byte
	contentType := "application/json"
	if raw, ok := payload.(rawBody); ok {
		body, contentType = raw, "image/png"
	} else if payload != nil {
		body, _ = json.Marshal(payload)
	}
	var lastErr error
	for attempt := range 6 {
		if attempt > 0 {
			time.Sleep(time.Duration(1<<attempt) * time.Second)
		}
		req, _ := http.NewRequest(method, apiURL+path, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", contentType)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		data, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err == nil && res.StatusCode == 200 {
			if out == nil {
				return nil
			}
			return json.Unmarshal(data, out)
		}
		lastErr = fmt.Errorf("%s %s: status %d: %.300s", method, path, res.StatusCode, data)
		if res.StatusCode != 429 && res.StatusCode < 500 {
			return lastErr
		}
	}
	return lastErr
}
