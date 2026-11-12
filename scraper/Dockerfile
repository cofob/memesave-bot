FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /scraper .

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/* \
  && useradd -m scraper
COPY --from=build /scraper /scraper
COPY NOTICE /NOTICE
USER scraper
EXPOSE 8080
ENTRYPOINT ["/scraper"]
