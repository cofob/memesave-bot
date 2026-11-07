FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY fonts ./fonts
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /analyze .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /analyze /analyze
ENTRYPOINT ["/analyze"]
