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
	Solution  struct {
		Token string `json:"token"`
	} `json:"solution"`
}

func ncCall(ctx context.Context, path string, body any) (*ncReply, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, nocaptchaURL+path, bytes.NewReader(b))
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
		return nil, fmt.Errorf("nocaptcha %s: error %d %v %s", path, r.ErrorID, r.ErrorCode, r.Status)
	}
	return &r, nil
}

// turnstile solves the Turnstile widget sitekey of the page websiteURL and returns its token.
func turnstile(ctx context.Context, key, websiteURL, sitekey string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, nocaptchaMax)
	defer cancel()
	t, err := ncCall(ctx, "/createTask", map[string]any{"clientKey": key, "task": map[string]string{"type": "AntiTurnstileTask", "websiteURL": websiteURL, "websiteKey": sitekey}})
	if err != nil {
		return "", err
	}
	for {
		select {
		case <-time.After(nocaptchaPoll):
		case <-ctx.Done():
			return "", ctx.Err()
		}
		r, err := ncCall(ctx, "/getTaskResult", map[string]string{"clientKey": key, "taskId": t.TaskID})
		if err != nil {
			return "", err
		}
		if r.Status == "ready" {
			return r.Solution.Token, nil
		}
	}
}
