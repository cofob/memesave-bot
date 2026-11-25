package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// NoCaptchaAI (docs.nocaptchaai.com): a Turnstile token from createTask, polled with getTaskResult.
// The API refuses the documented TurnstileTaskProxyLess ("Payload not valid"); AntiTurnstileTask works.

var (
	nocaptchaURL  = "https://api.nocaptchaai.com"
	nocaptchaPoll = 2 * time.Second
)

const nocaptchaMax = 120 * time.Second

type ncReply struct {
	ErrorID   int    `json:"errorId"`
	ErrorCode any    `json:"errorCode"`
	Status    string `json:"status"`
	TaskID    string `json:"taskId"`
	ErrorDesc string `json:"errorDescription"`
	Solution  struct {
		Token     string            `json:"token"`
		Cookies   map[string]string `json:"cookies"`   // CapSolver: cf_clearance
		UserAgent string            `json:"userAgent"` // CapSolver: the User-Agent the cookies are bound to
	} `json:"solution"`
}

func ncCall(ctx context.Context, base, path string, body any) (*ncReply, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+path, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var r ncReply
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("nocaptcha %s: %d %w", path, res.StatusCode, err)
	}
	if r.ErrorID != 0 || r.Status == "failed" {
		return nil, fmt.Errorf("%s%s: error %d %v %s %s", base, path, r.ErrorID, r.ErrorCode, r.Status, r.ErrorDesc)
	}
	return &r, nil
}

// task creates the task at the API base (NoCaptchaAI and CapSolver have one API shape) and polls it until ready.
func task(ctx context.Context, base, key string, t map[string]string) (*ncReply, error) {
	ctx, cancel := context.WithTimeout(ctx, nocaptchaMax)
	defer cancel()
	c, err := ncCall(ctx, base, "/createTask", map[string]any{"clientKey": key, "task": t})
	if err != nil {
		return nil, err
	}
	for {
		select {
		case <-time.After(nocaptchaPoll):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		r, err := ncCall(ctx, base, "/getTaskResult", map[string]string{"clientKey": key, "taskId": c.TaskID})
		if err != nil || r.Status == "ready" {
			return r, err
		}
	}
}

// turnstile solves the Turnstile widget sitekey of the page websiteURL and returns its token.
func turnstile(ctx context.Context, key, websiteURL, sitekey string) (string, error) {
	r, err := task(ctx, nocaptchaURL, key, map[string]string{"type": "AntiTurnstileTask", "websiteURL": websiteURL, "websiteKey": sitekey})
	if err != nil {
		return "", err
	}
	return r.Solution.Token, nil
}
