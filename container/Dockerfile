FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /zipimport .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /zipimport /zipimport
ENTRYPOINT ["/zipimport"]
