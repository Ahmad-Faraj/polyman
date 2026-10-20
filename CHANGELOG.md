# Changelog

## 3.0.2

- polyman retries a Polygon call once when Polygon answers with a server error or an HTML page, for reads and for uploads that replace an item; calls that could create a duplicate are never retried.
